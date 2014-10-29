'use strict';

var EventEmitter = require('eventemitter3')
  , Tick = require('tick-tock');

/**
 * Proper type checking.
 *
 * @param {Mixed} of Thing we want to know the type of.
 * @returns {String} The type.
 * @api private
 */
function type(of) {
  return Object.prototype.toString.call(of).slice(8, -1).toLowerCase();
}

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
 * A nope function for when people don't want message acknowledgements. Because
 * they don't care about CAP.
 *
 * @api private
 */
function nope() {}

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
    min: Tick.parse(options['heartbeat min'] || this.election.min),
    max: Tick.parse(options['heartbeat max'] || this.election.max)
  };

  this.votes = {
    for: null,                // Who did we vote for in this current term.
    granted: 0                // How many votes we're granted to us.
  };

  this.threshold = options.threshold || 0.8;
  this.name = options.name || UUID();
  this.timers = new Tick(this);
  this.nodes = [];

  //
  // Raft §5.2:
  //
  // When a server starts, it's always started as Follower and it will remain in
  // this state until receive a message from a Leader or Candidate.
  //
  this.state = Node.FOLLOWER; // Our current state.
  this.leader = null;         // Leader in our cluster.
  this.term = 0;              // Our current term.

  this.initialize(options);
}

//
// Add some sugar and spice and everything nice. Oh, and also inheritance.
//
Node.extend = require('extendable');
Node.prototype = new EventEmitter();
Node.prototype.constructor = Node;

/**
 * Raft §5.1:
 *
 * A Node can be in only one of the various states. The stopped state is not
 * something that is part of the Raft protocol but something we might want to
 * use internally while we're starting or shutting down our node.
 *
 * @type {Number}
 * @private
 */
Node.LEADER    = 1;   // We're selected as leader process.
Node.CANDIDATE = 2;   // We want to be promoted to leader.
Node.FOLLOWER  = 3;   // We're just following a leader.
Node.STOPPED   = 4;   // Assume we're dead.

/**
 * Initialize the node and start listening to the various of events we're
 * emitting as we're quite chatty to provide the maximum amount of flexibility
 * and reconfigurability.
 *
 * @param {Object} options The configuration you passed in the constructor.
 * @api private
 */
Node.prototype.initialize = function initialize(options) {
  //
  // Reset our vote as we're starting a new term. Votes only last one term.
  //
  this.on('term change', function change() {
    this.votes.for = null;
    this.votes.granted = 0;
  });

  //
  // Reset our times and start the heartbeat again. If we're promoted to leader
  // the heartbeat will automatically be broadcasted to users as well.
  //
  this.on('state change', function change(currently, previously) {
    this.timers.clear();
    this.heartbeat();
  });

  //
  // Receive incoming messages and process them.
  //
  this.on('data', function incoming(packet, write) {
    write = write || nope;

    if ('object' !== type(packet)) {
      return write(new Error('Invalid packet received'));
    }

    //
    // Raft §5.1:
    //
    // Applies to all states. If a response contains a higher term then our
    // current term need to change our state to FOLLOWER and set the received
    // term.
    //
    // If the node receives a request with a stale term number it should be
    // rejected.
    //
    if (packet.term > this.term) {
      this.change({
        leader: packet.leader,
        state: Node.FOLLOWER,
        term: packet.term
      });
    } else if (packet.term < this.term) {
      return write(new Error('Stale term detected, we are at '+ this.term));
    }

    //
    // Raft §5.2:
    //
    // If we receive a message from someone who claims to be leader and shares
    // our same term while we're in candidate mode we will recognize their
    // leadership and return as follower
    //
    if (Node.LEADER === packet.state && Node.FOLLOWER !== this.state) {
      this.change({ state: Node.FOLLOWER, leader: packet.leader });
    }

    //
    // Always when we receive an message from the Leader we need to reset our
    // heartbeat.
    //
    if (Node.LEADER === packet.state) {
      this.heartbeat();
    }

    switch (packet.type) {
      //
      // Raft §5.2:
      // Raft §5.4:
      //
      // A node asked us to vote on them. We can only vote to them if they
      // represent a higher term (and last log term, last log index).
      //
      case 'vote':
        //
        // The term of the vote is bigger then ours so we need to update it. If
        // it's the same and we already voted, we need to deny the vote.
        //
        if (this.votes.for && this.votes.for !== packet.name) {
          this.emit('vote', packet, false);
          return write(undefined, this.packet('vote', { granted: false }));
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
        this.votes.for = packet.name;
        this.emit('vote', packet, true);
        write(undefined, this.packet('vote', { granted: true }));
      break;

      //
      // A new incoming vote.
      //
      case 'voted':
        //
        // Only accepts votes while we're still in a CANDIDATE state.
        //
        if (Node.CANDIDATE !== this.state) {
          return write(new Error('No longer a candidate'));
        }

        //
        // Increment our received votes when our voting request has been
        // granted by the node that received the data.
        //
        if (packet.data.granted) this.votes.granted++;

        //
        // Check if we've received the minimal amount of votes required for this
        // current voting round to be considered valid
        //
        if (this.quorum(this.votes.granted)) {
          this.change({ leader: this.name, state: Node.LEADER });
        }

        //
        // Empty write, nothing to do.
        //
        write();
      break;

      case 'append':
      break;

      case 'log':
      break;

      //
      // Unknown event, we have no idea how to process this so we're going to
      // return an error.
      //
      default:
        write(new Error('Unknown message type: '+ packet.type));
    }
  });

  //
  // Setup the log appends.
  //

  //
  // The node is now listening to events so we can start our heartbeat timeout.
  // So that if we don't hear anything from a leader we can promote our selfs to
  // a candidate state.
  //
  this.heartbeat();
};

/**
 * Check if we've reached our quorum (a.k.a. minimum amount of votes requires
 * for a voting round to be considered valid) for the given amount of votes.
 *
 * @param {Number} responses Amount of responses received.
 * @returns {Boolean}
 * @api private
 */
Node.prototype.quorum = function quorum(responses) {
  if (!this.nodes.length || !responses) return false;
  return responses >= this.majority();
};

/**
 * The majority required to reach our the quorum.
 *
 * @returns {Number}
 * @api private
 */
Node.prototype.majority = function majority() {
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
    , currently, previously
    , i = 0;

  if (!changed) return this;

  for (; i < changes.length; i++) {
    if (changes[i] in changed && changed[changes[i]] !== this[changes[i]]) {
      currently = changed[changes[i]];
      previously = this[changes[i]];

      this[changes[i]] = currently;
      this.emit(changes[i] +' change', currently, previously);
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
  duration = duration || this.timeout('beat');

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
    // @TODO We're the LEADER so we should be broadcasting.
    //
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
 * Raft §5.2:
 *
 * We've detected a timeout from the leaders heartbeats and need to start a new
 * election for leadership. We increment our current term, set the CANDIDATE
 * state, vote our selfs and ask all others nodes to vote for us.
 *
 * @returns {Node}
 * @api public
 */
Node.prototype.promote = function promote() {
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

  //
  // Set the election timeout. This gives the nodes some time to reach
  // consensuses about who they want to vote for. If no consensus has been
  // reached within the set timeout we will attempt it again.
  //
  this.timers.setTimeout('election', this.promote, this.timeout('election'));

  return this;
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
    state:  this.state,   // So you know if we're a leader, candidate or follower.
    term:   this.term,    // Our current term so we can find mis matches.
    name:   this.name,    // Name of the sender.
    data:   data,         // Custom data we send.
    type:   type,         // Message type.
    leader: this.leader   // Who is our leader.
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
