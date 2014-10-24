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

  this.id = options.id || UUID();
  this.timers = new Tick();
  this._write = write;

  //
  // 5.2: When a server starts, it's always started as Follower and it will
  // remain in this state until receive a message from a Leader or Candidate.
  //
  this.state = Node.FOLLOWER;
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

/**
 * Initialize the node.
 *
 * @api private
 */
Node.prototype.initialize = function initialize() {
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
      if (data.term >= this.term) this.state = Node.FOLLOWER;
      else return; /* We need to ignore the RPC as it's in an incorrect state */
    }

    switch (data.type) {
      case 'heartbeat':
        if (Node.LEADER === data.state) {
          this.heartbeat(data.payload);
        }
      break;

      case 'vote':
        this.vote(data);
      break;

      case 'rpc':
      break;
    }
  });
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

  this.timers.setTimeout('heartbeat', this.promote, duration);

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

  this.state = Node.CANDIDATE;  // We're now a candidate,
  this.term++;                  // but only for this term.

  //
  // Candidates are always biased and vote for them selfs first before sending
  // out a voting request to all other nodes in the cluster.
  //
  var votes = 1;

  return this;
};

/**
 * A vote has come in, and we need to return our decision.
 *
 * @param {Object} data Details about the node that wants our vote.
 * @returns {Node}
 * @api public
 */
Node.prototype.vote = function vote(data) {
  return this;
};

/**
 * Write out a message.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} payload Data to be transfered.
 * @returns {Boolean} Successful write.
 * @api public
 */
Node.prototype.write = function write(type, payload, broadcast) {
  return this._write({
    state: this.state,    // So people know if we're a leader, candidate or follower
    term: this.term,      // Our current term so we can find mis matches

    payload: payload,
    type: type
  });
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
