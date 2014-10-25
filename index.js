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
 * @param {Function} read Method will be called to receive a callback.
 * @param {Function} write Called when the node needs to communicate.
 * @param {Object} options Node configuration.
 * @api public
 */
function Node(read, write, options) {
  if (!(this instanceof Node)) return new Node(read, write, options);

  options = options || {};

  this.election = {
    min: Tick.parse(options['election min'] || '150 ms'),
    max: Tick.parse(options['election max'] || '300 ms')
  };

  this.beat = {
    min: Tick.parse(options['heartbeat min'] || '150 ms'),
    max: Tick.parse(options['heartbeat max'] || '300 ms')
  };

  this.votes = {
    for: null,
    granted: 0
  };

  this.threshold = options.threshold || 0.8;
  this.name = options.name || UUID();
  this.timers = new Tick();
  this._write = write;

  //
  // 5.2: When a server starts, it's always started as Follower and it will
  // remain in this state until receive a message from a Leader or Candidate.
  //
  this.state = Node.FOLLOWER; // Our current state.
  this.leader = null;         // Leader in our cluster.
  this.term = 0;

  this.initialize();

  read(this.emits('RPC'));
}

Node.prototype = new EventEmitter();
Node.prototype.emits = require('emits');
Node.prototype.constructor = Node;

/**
 * The different states that a node can have.
 *
 * @type {Number}
 * @private
 */
Node.LEADER    = 1;
Node.CANDIDATE = 2;
Node.FOLLOWER  = 3;
Node.STOPPED   = 4;

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

  this.on('RPC', function incoming(data) {
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
      break;

      //
      // A new incoming vote.
      //
      case 'voted':
        //
        // Check if we've received the minimal amount of votes required for this
        // current voting round to be considered valid
        //
        if (this.votes.granted === (this.nodes.length / 2) + 1) {
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
 * Process a change in the node.
 *
 * @param {Object} changed Data that is changed.
 * @returns {Node}
 * @api private
 */
Node.prototype.change = function change(changed) {
  var changes = ['term', 'leader', 'state']
    , i = 0;

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
    if (Node.LEADER !== this.state) return this.promote();

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
  var times = this[which] || this.beat;

  return Math.min(
    Math.round((Math.random() * 1) * times.min),
    times.max
  );
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
 * Write out a message.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} data Data to be transfered.
 * @returns {Boolean} Successful write.
 * @api public
 */
Node.prototype.write = function write(type, data) {
  return this._write(this.packet(type, data));
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
