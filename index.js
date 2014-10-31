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
 * - `name`: An unique id of this given node.
 * - `heartbeat min`: Minimum heartbeat timeout.
 * - `heartbeat max`: Maximum heartbeat timeout.
 * - `election min`: Minimum election timeout.
 * - `election max`: Maximum election timeout.
 * - `threshold`: Threshold when the heartbeat RTT is close to the election
 *   timeout.
 * - `Log`: A Log constructor that should be used to store commit logs.
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

  this.write = this.write || options.write || null;
  this.threshold = options.threshold || 0.8;
  this.name = options.name || UUID();
  this.timers = new Tick(this);
  this.Log = options.Log;
  this.log = null;
  this.nodes = [];

  //
  // Raft §5.2:
  //
  // When a server starts, it's always started as Follower and it will remain in
  // this state until receive a message from a Leader or Candidate.
  //
  this.state = Node.FOLLOWER; // Our current state.
  this.leader = '';           // Leader in our cluster.
  this.term = 0;              // Our current term.

  this.initialize(options);
}

//
// Add some sugar and spice and everything nice. Oh, and also inheritance.
//
Node.extend = require('extendible');
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
        // @TODO point to index of last commit entry.
        // @TODO point to term of last commit entry.
        //
        if (this.log && packet.last && (
             this.log.index > packet.last.index
          || this.term > packet.last.term
        )) {
          this.emit('vote', packet, false);
          return write(undefined, this.packet('vote', { granted: false }));
        }

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

      //
      // Remark: Are we assuming we are getting an appendEntries from the
      // leader and comparing and appending our log?
      //
      case 'append':
      break;

      //
      // Remark: So does this get emit when we need to write our OWN log?
      //
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
  // We do not need to execute the functionality below if we have a write method
  // assigned to our selfs. This prevents us from timing out and other nasty
  // stuff.
  //
  if (this.write) return;

  //
  // Setup the log & appends. Assume that if we're given a function log that it
  // needs to be initialized as it requires access to our node instance so it
  // can read our information like our leader, state, term etc.
  //
  if ('function' === type(this.Log)) {
    this.log = new this.Log(this, options);
  }

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
 * @api private
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
 * @api private
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
 * @api private
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
  // Broadcast the voting request to all connected nodes in your private
  // cluster.
  //
  var packet = this.packet('vote')
    , i = 0;

  for (; i < this.nodes.length; i++) {
    this.nodes[i].write(packet);
  }

  //
  // Set the election timeout. This gives the nodes some time to reach
  // consensuses about who they want to vote for. If no consensus has been
  // reached within the set timeout we will attempt it again.
  //
  this.timers
    .clear() // Clear all old timers, this one is the most important now.
    .setTimeout('election', this.promote, this.timeout('election'));

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
Node.prototype.packet = function wrap(type, data) {
  var packet = {
    state:  this.state,   // So you know if we're a leader, candidate or follower.
    term:   this.term,    // Our current term so we can find mis matches.
    name:   this.name,    // Name of the sender.
    data:   data,         // Custom data we send.
    type:   type,         // Message type.
    leader: this.leader,  // Who is our leader.
  };

  //
  // If we have logging and state replication enabled we also need to send this
  // additional data so we can use it determine the state of this node.
  //
  // @TODO point to index of last commit entry.
  // @TODO point to term of last commit entry.
  //
  if (this.log) packet.last = { term: this.term, index: this.log.index };
  return packet;
};

/**
 * Create a clone of the current instance with the same configuration. Ideally
 * for creating connected nodes in a cluster.. And let that be something we're
 * planning on doing.
 *
 * @param {Object} options Configuration that should override the default config.
 * @returns {Node} The newly created instance.
 * @api public
 */
Node.prototype.clone = function clone(options) {
  options = options || {};

  var node = {
    'election min': this.election.min,
    'election max': this.election.max,
    'heartbeat min': this.beat.min,
    'heartbeat max': this.beat.max,
    'threshold': this.threshold,
    'Log': this.Log
  }, key;

  for (key in node) {
    if (key in options || !node.hasOwnProperty(key)) continue;
    options[key] = node[key];
  }

  return new this.constructor(options);
};

/**
 * A new node is about to join the cluster. So we need to upgrade the
 * configuration of every single node.
 *
 * @param {String} name The name of the node that is connected.
 * @param {Function} write A method that we use to write data.
 * @returns {Node} The node we created and that joined our cluster.
 * @api public
 */
Node.prototype.join = function join(name, write) {
  if ('function' === type(name)) {
    write = name; name = null;
  }

  var node = this.clone({
    write: write,   // Function that receives our writes.
    name: name      // A custom name for the node we added.
  });

  node.once('end', function end() {
    this.leave(node);
  }, this);

  this.nodes.push(node);
  this.emit('join', node);

  return node;
};

/**
 * Remove a node from the cluster.
 *
 * @returns {Node} The node that we removed.
 * @api public
 */
Node.prototype.leave = function leave(name) {
  var index = -1
    , node;

  for (var i = 0; i < this.nodes.length; i++) {
    if (this.nodes[i] === name || this.nodes[i].name === name) {
      node = this.nodes[i];
      index = i;
      break;
    }
  }

  if (~index && node) {
    if (node.end) node.end();
    this.nodes.splice(index, 1);
    this.emit('leave', node);
  }

  return node;
};

/**
 * This Node needs to be shut down.
 *
 * @returns {Boolean} Successful destruction.
 * @api public
 */
Node.prototype.end = function end() {
  if (Node.STOPPED === this.state) return false;
  this.state = Node.STOPPED;

  if (this.nodes.length) for (var i = 0; i < this.nodes.length; i++) {
    this.leave(this.nodes[i]);
  }

  this.emit('end');
  this.timers.end();
  this.removeAllListeners();

  if (this.log) this.log.end();
  this.timers = this.log = this.Log = this.beat = this.election = null;

  return true;
};

//
// Expose the module interface.
//
module.exports = Node;
