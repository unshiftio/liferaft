'use strict';

var EventEmitter = require('eventemitter3')
  , Tick = require('tick-tock');

/**
 * Generate a somewhat unique UUID.
 *
 * @see stackoverflow.com/q/105034
 * @returns {String} UUID.
 * @api private
 */
function UUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function gen(c) {
    var random = Math.random() * 16 | 0
      , value = c !== 'x'
        ? (random & 0x3 | 0x8)
        : random;

    return value.toString(16);
  });
}

/**
 * Representation of a single node in the cluster.
 *
 * Options:
 *
 * - `id`: An unique id of this given node.
 * - `heartbeat min`: Minimum heartbeat timeout.
 * - `heartbeat max`: Maximum heartbeat timeout.
 * - `election min`: Minimum election timeout.
 * - `election max`: Maximum election timeout.
 * - `threshold`: Threshold when the heartbeat RTT is close to the election
 *   timeout.
 *
 * @constructor
 * @param {Object} options Node configuration.
 * @api public
 */
function Node(options) {
  if (!(this instanceof Node)) return new Node(options);

  options = options || {};

  this.election = {
    min: Tick.parse(options['election min'] || '150 ms'),
    max: Tick.parse(options['election max'] || '300 ms')
  };

  this.beat = {
    min: Tick.parse(options['heartbeat min'] || '50 ms'),
    max: Tick.parse(options['heartbeat max'] || '70 ms')
  };

  this.votes = {
    for: null,                // Who did we vote for in this current term.
    granted: 0                // How many votes we're granted to us.
  };

  this.threshold = options.threshold || 0.8;
  this.name = options.name || UUID();
  this.timers = new Tick(this);

  //
  // 5.2: When a server starts, it's always started as Follower and it will
  // remain in this state until receive a message from a Leader or Candidate.
  //
  this.state = Node.FOLLOWER; // Our current state.
  this.leader = null;         // Leader in our cluster.
  this.term = 0;              // Our current term.

  this.initialize();
}

//
// Add some sugar and spice and everything nice. Oh, and also inheritance.
//
Node.extend = require('extendable');
Node.prototype = new EventEmitter();
Node.prototype.emits = require('emits');
Node.prototype.constructor = Node;

/**
 * The different states that a node can have.
 *
 * @type {Number}
 * @private
 */
Node.LEADER    = 1;   // We're selected as leader process.
Node.CANDIDATE = 2;   // We want to be promoted to leader.
Node.FOLLOWER  = 3;   // We're just following a leader.
Node.STOPPED   = 4;   // Assume we're dead.

/**
 * Initialize the node.
 *
 * @api private
 */
Node.prototype.initialize = function initialize() {
  this.on('term change', function change() {
    //
    // Reset our vote as we're starting a new term. Votes only last one term.
    //
    this.votes.for = null;
    this.votes.granted = 0;
  });

  this.on('data', function incoming(data) {
    if ('object' !== typeof data) return; /* Invalid data structure, G.T.F.O. */

    //
    // We're waiting for votes to come in as we're promoted to a candidate but
    // a new node with a leadership role just send us a message. If his term is
    // greater then ours we will step down as candidate and acknowledge their
    // leadership.
    //
    if (
         Node.CANDIDATE === this.state
      && Node.LEADER === this.state
    ) {
      if (data.term >= this.term) {
        this.change({
          state: Node.FOLLOWER,
          term: data.term
        });
      }
      else return; /* We need to ignore the RPC as it's in an incorrect state */
    }

    switch (data.type) {
      case 'heartbeat':
        if (Node.LEADER === data.state) {
          this.heartbeat(data.data);
        }
      break;

      //
      // A node asked us to vote on them. We can only vote to them if they
      // represent a higher term (and last log term, last log index).
      //
      case 'vote':
        //
        // If the request is coming from an old term we should deny it.
        //
        if (data.term < this.term) {
          return this.write('vote', { accepted: false });
        }

        //
        // The term of the vote is bigger then ours so we need to update it. If
        // it's the same and we already voted, we need to deny the vote.
        //
        if (data.term > this.term) this.change({ term: data.term });
        else if (this.votes.for && this.votes.for !== data.name) {
          return this.write('vote', { accepted: false });
        }

        //
        // If we maintain a log, check if the candidates log is as up to date as
        // ours.
        //

        //
        // We've made our decision, we haven't voted for this term yet and this
        // candidate came in first so it gets our vote as all requirements are
        // met.
        //
        this.votes.for = data.name;
        this.write('vote', { accepted: true });
      break;

      //
      // A new incoming vote.
      //
      case 'voted':
        //
        // Only accepts votes while we're still in a CANDIDATE state.
        //
        if (Node.CANDIDATE !== this.state) return;

        //
        // Increment our received votes when our voting request has been
        // accepted by the node that received the data.
        //
        if (data.payload.accepted && data.term === this.term) {
          this.votes.granted++;
        }

        //
        // Again, update our term if it's out sync.
        //
        if (data.term > this.term) this.change({ term: data.term });

        //
        // Check if we've received the minimal amount of votes required for this
        // current voting round to be considered valid
        //
        if (this.votes.granted >= this.quorum()) {
          this.change({
            leader: this.name,
            state: Node.LEADER
          });
        }
      break;

      case 'rpc':
      break;
    }
  });
};

/**
 * The minimum amount of votes we need to receive in order for a voting round to
 * be considered valid.
 *
 * @returns {Number}
 * @api private
 */
Node.prototype.quorum = function quorum() {
  return Math.ceil(this.nodes.length / 2) + 1;
};

/**
 * Process a change in the node.
 *
 * @param {Object} changed Data that is changed.
 * @returns {Node}
 * @api private
 */
Node.prototype.change = function change(changed) {
  var changes = ['term', 'leader', 'state']
    , i = 0;

  if (!changed) return this;

  for (; i < changes.length; i++) {
    if (changes[i] in changed && changed[changes[i]] !== this[changes[i]]) {
      this[changes[i]] = changed[changes[i]];
      this.emit(changes[i] +' change');
    }
  }

  return this;
};

/**
 * Start or update the heartbeat of the Node. If we detect that we've received
 * a heartbeat timeout we will promote our selfs to a candidate to take over the
 * leadership.
 *
 * @param {String|Number} duration Time it would take for the heartbeat to timeout.
 * @returns {Node}
 * @api public
 */
Node.prototype.heartbeat = function heartbeat(duration) {
  duration = duration || this.timeout('heartbeat');

  if (this.timers.active('heartbeat')) {
    this.timers.adjust('heartbeat', duration);
    return this;
  }

  this.timers.setTimeout('heartbeat', function () {
    if (Node.LEADER !== this.state) {
      this.emit('heartbeat timeout');
      return this.promote();
    }

    //
    // We're the LEADER so we should be broadcasting.
    //
    this.broadcast('heartbeat');
  }, duration);

  return this;
};

/**
 * Generate the various of timeouts.
 *
 * @param {String} which Type of timeout we want to generate.
 * @returns {Number}
 * @api public
 */
Node.prototype.timeout = function timeout(which) {
  var times = this[which];

  return Math.floor(Math.random() * (times.max - times.min + 1) + times.min);
};

/**
 * Node detected a failure in the cluster and wishes to be promoted to new
 * master and promotes it self to candidate.
 *
 * @returns {Node}
 * @api public
 */
Node.prototype.promote = function promote() {
  if (Node.CANDIDATE === this.state) return this;

  this.change({
    state: Node.CANDIDATE,  // We're now a candidate,
    term: this.term + 1,    // but only for this term.
    leader: ''              // We no longer have a leader.
  });

  //
  // Candidates are always biased and vote for them selfs first before sending
  // out a voting request to all other nodes in the cluster.
  //
  this.votes.for = this.name;
  this.votes.granted = 1;
  this.broadcast('vote');

  return this;
};

/**
 * While we don't really adapt the Stream interface here from node, we still
 * want to follow it's API signature. So we assume that the `write` method will
 * return a boolean indicating if the packet has been written.
 *
 * @param {Object} packet The data that needs to be written.
 * @returns {Boolean} Indication that the message was written.
 * @api public
 */
Node.prototype.write = function write(packet) {
  return false;
};

/**
 * Read and process an incoming data packet.
 *
 * @returns {Boolean} Did we read the message.
 * @api public
 */
Node.prototype.read = function read(packet) {
  return this.emit('data', packet);
};

/**
 * Broadcast a message.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} data Data to be transfered.
 * @returns {Boolean} Successful write.
 * @api public
 */
Node.prototype.broadcast = function broadcast(type, data) {
  var packet = this.packet(type, data);
};

/**
 * Wrap the outgoing messages in an object with additional required data.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} data Data to be transfered.
 * @returns {Object} Packet.
 * @api private
 */
Node.prototype.packet = function packet(type, data) {
  return {
    state: this.state,  // So you know if we're a leader, candidate or follower
    term:  this.term,   // Our current term so we can find mis matches
    name:  this.name,   // Name of the sender.
    data:  data,        // Custom data we send.
    type:  type         // Message type.
  };
};

/**
 * This Node needs to be shut down.
 *
 * @returns {Boolean} Successful destruction.
 * @api public
 */
Node.prototype.end = function end() {
  if (!this.state) return false;

  this.timers.end();
  this.removeAllListeners();

  this.timers = this.state = this.write = this.read = null;

  return true;
};

//
// Expose the module interface.
//
module.exports = Node;
