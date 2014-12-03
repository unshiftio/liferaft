'use strict';

var EventEmitter = require('eventemitter3')
  , Tick = require('tick-tock')
  , one = require('one-time');

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
 * - `address`: An unique id of this given node.
 * - `heartbeat`: Heartbeat timeout.
 * - `election min`: Minimum election timeout.
 * - `election max`: Maximum election timeout.
 * - `threshold`: Threshold when the heartbeat RTT is close to the election
 *   timeout.
 * - `Log`: A Log constructor that should be used to store commit logs.
 * - `state`: Our initial state. This is a private property and should not be
 *   set you unless you know what your are doing but as you want to use this
 *   property I highly doubt that that..
 *
 * Please note, when adding new options make sure that you also update the
 * `Node#join` method so it will correctly copy the new option to the clone as
 * well.
 *
 * @constructor
 * @param {Mixed} address Unique address, id or name of this given node.
 * @param {Object} options Node configuration.
 * @api public
 */
function Node(address, options) {
  if (!(this instanceof Node)) return new Node(options);

  options = options || {};

  if ('object' === typeof address) options = address;
  else if (!options.address) options.address = address;

  this.election = {
    min: Tick.parse(options['election min'] || '150 ms'),
    max: Tick.parse(options['election max'] || '300 ms')
  };

  this.beat = Tick.parse(options.heartbeat || '50 ms');

  this.votes = {
    for: null,                // Who did we vote for in this current term.
    granted: 0                // How many votes we're granted to us.
  };

  this.write = this.write || options.write || null;
  this.threshold = options.threshold || 0.8;
  this.address = options.address || UUID();
  this.timers = new Tick(this);
  this.Log = options.Log;
  this.latency = 0;
  this.log = null;
  this.nodes = [];

  //
  // Raft §5.2:
  //
  // When a server starts, it's always started as Follower and it will remain in
  // this state until receive a message from a Leader or Candidate.
  //
  this.state = options.state || Node.FOLLOWER;    // Our current state.
  this.leader = '';                               // Leader in our cluster.
  this.term = 0;                                  // Our current term.

  this._initialize(options);
}

//
// Add some sugar and spice and everything nice. Oh, and also inheritance.
//
Node.extend = require('extendible');
Node.prototype = new EventEmitter();
Node.prototype.constructor = Node;
Node.prototype.emits = require('emits');

/**
 * Raft §5.1:
 *
 * A Node can be in only one of the various states. The stopped state is not
 * something that is part of the Raft protocol but something we might want to
 * use internally while we're starting or shutting down our node. The following
 * states are generated:
 *
 * - STOPPED:   Assume we're dead.
 * - LEADER:    We're selected as leader process.
 * - CANDIDATE: We want to be promoted to leader.
 * - FOLLOWER:  We're just following a leader.
 * - CHILD:     A node that has been added using JOIN.
 *
 * @type {Number}
 * @private
 */
Node.states = 'STOPPED,LEADER,CANDIDATE,FOLLOWER,CHILD'.split(',');
for (var s = 0; s < Node.states.length; s++) {
  Node[Node.states[s]] = s;
}

/**
 * Initialize the node and start listening to the various of events we're
 * emitting as we're quite chatty to provide the maximum amount of flexibility
 * and reconfigurability.
 *
 * @param {Object} options The configuration you passed in the constructor.
 * @api private
 */
Node.prototype._initialize = function initializing(options) {
  var node = this;

  //
  // Reset our vote as we're starting a new term. Votes only last one term.
  //
  node.on('term change', function change() {
    node.votes.for = null;
    node.votes.granted = 0;
  });

  //
  // Reset our times and start the heartbeat again. If we're promoted to leader
  // the heartbeat will automatically be broadcasted to users as well.
  //
  node.on('state change', function change(state) {
    node.timers.clear('heartbeat, election');
    node.heartbeat(Node.LEADER === node.state ? node.beat : node.timeout());
    node.emit(Node.states[state].toLowerCase());
  });

  //
  // Receive incoming messages and process them.
  //
  node.on('data', function incoming(packet, write) {
    write = write || nope;
    var reason;

    if ('object' !== node.type(packet)) {
      reason = 'Invalid packet received';
      node.emit('error', new Error(reason));
      return write(node.packet('error', reason));
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
    if (packet.term > node.term) {
      node.change({
        leader: Node.LEADER === packet.state ? packet.address : packet.leader || node.leader,
        state: Node.FOLLOWER,
        term: packet.term
      });
    } else if (packet.term < node.term) {
      reason = 'Stale term detected, received `'+ packet.term +'` we are at '+ node.term;
      node.emit('error', new Error(reason));
      return write(node.packet('error', reason));
    }

    //
    // Raft §5.2:
    //
    // If we receive a message from someone who claims to be leader and shares
    // our same term while we're in candidate mode we will recognize their
    // leadership and return as follower.
    //
    // If we got this far we already know that our terms are the same as it
    // would be changed or prevented above..
    //
    if (Node.LEADER === packet.state) {
      if (Node.FOLLOWER !== node.state) node.change({ state: Node.FOLLOWER });
      if (packet.address !== node.leader) node.change({ leader: packet.address });

      //
      // Always when we receive an message from the Leader we need to reset our
      // heartbeat.
      //
      node.heartbeat(node.timeout());
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
        if (node.votes.for && node.votes.for !== packet.address) {
          node.emit('vote', packet, false);
          return write(node.packet('voted', { granted: false }));
        }

        //
        // If we maintain a log, check if the candidates log is as up to date as
        // ours.
        //
        // @TODO point to index of last commit entry.
        // @TODO point to term of last commit entry.
        //
        if (node.log && packet.last && (
             node.log.index > packet.last.index
          || node.term > packet.last.term
        )) {
          node.emit('vote', packet, false);
          return write(node.packet('voted', { granted: false }));
        }

        //
        // We've made our decision, we haven't voted for this term yet and this
        // candidate came in first so it gets our vote as all requirements are
        // met.
        //
        node.votes.for = packet.address;
        node.emit('vote', packet, true);
        node.change({ leader: packet.address, term: packet.term });
        write(node.packet('voted', { granted: true }));

        //
        // We've accepted someone as potential new leader, so we should reset
        // our heartbeat to prevent this node from timing out after voting.
        // Which would again increment the term causing us to be next CANDIDATE
        // and invalidates the request we just got, so that's silly willy.
        //
        node.heartbeat(node.timeout());
      break;

      //
      // A new incoming vote.
      //
      case 'voted':
        //
        // Only accepts votes while we're still in a CANDIDATE state.
        //
        if (Node.CANDIDATE !== node.state) {
          return write(node.packet('error', 'No longer a candidate, ignoring vote'));
        }

        //
        // Increment our received votes when our voting request has been
        // granted by the node that received the data.
        //
        if (packet.data.granted) {
          node.votes.granted++;
        }

        //
        // Check if we've received the minimal amount of votes required for this
        // current voting round to be considered valid.
        //
        if (node.quorum(node.votes.granted)) {
          node.change({ leader: node.address, state: Node.LEADER });

          //
          // Send a heartbeat message to all connected clients.
          //
          node.message(Node.FOLLOWER, node.packet('append'));
        }

        //
        // Empty write, nothing to do.
        //
        write();
      break;

      case 'error':
        node.emit('error', new Error(packet.data));
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
      // RPC command
      //
      case 'exec':
      break;

      //
      // Unknown event, we have no idea how to process this so we're going to
      // return an error.
      //
      default:
        if (node.listeners('rpc').length) {
          node.emit('rpc', packet, write);
        } else {
          write(node.packet('error', 'Unknown message type: '+ packet.type));
        }
    }
  });

  //
  // We do not need to execute the rest of the functionality below as we're
  // currently running as "child" node of the cluster not as the "root" node.
  //
  if (Node.CHILD === node.state) return node.emit('initialize');

  //
  // Setup the log & appends. Assume that if we're given a function log that it
  // needs to be initialized as it requires access to our node instance so it
  // can read our information like our leader, state, term etc.
  //
  if ('function' === node.type(node.Log)) {
    node.log = new node.Log(node, options);
  }

  /**
   * The node is now listening to events so we can start our heartbeat timeout.
   * So that if we don't hear anything from a leader we can promote our selfs to
   * a candidate state.
   *
   * Start listening listening for heartbeats when implementors are also ready
   * with setting up their code.
   *
   * @api private
   */
  function initialize(err) {
    if (err) return node.emit('error', err);

    node.emit('initialize');
    node.heartbeat(node.timeout());
  }

  if ('function' === node.type(node.initialize)) {
    if (node.initialize.length > 1) return node.initialize(options, initialize);
    node.initialize(options);
  }

  initialize();
};

/**
 * Proper type checking.
 *
 * @param {Mixed} of Thing we want to know the type of.
 * @returns {String} The type.
 * @api private
 */
Node.prototype.type = function type(of) {
  return Object.prototype.toString.call(of).slice(8, -1).toLowerCase();
};

/**
 * Check if we've reached our quorum (a.k.a. minimum amount of votes requires
 * for a voting round to be considered valid) for the given amount of votes.
 *
 * @param {Number} responses Amount of responses received.
 * @returns {Boolean}
 * @api public
 */
Node.prototype.quorum = function quorum(responses) {
  if (!this.nodes.length || !responses) return false;

  return responses >= this.majority();
};

/**
 * The majority required to reach our the quorum.
 *
 * @returns {Number}
 * @api public
 */
Node.prototype.majority = function majority() {
  return Math.ceil(this.nodes.length / 2) + 1;
};

/**
 * Attempt to run a function indefinitely until the callback is called.
 *
 * @param {Function} attempt Function that needs to be attempted.
 * @param {Function} fn Completion callback.
 * @param {Number} timeout Which timeout should we use.
 * @returns {Node}
 * @api public
 */
Node.prototype.indefinitely = function indefinitely(attempt, fn, timeout) {
  var uuid = UUID()
    , node = this;

  (function again() {
    //
    // We need to force async execution here because we do not want to saturate
    // the event loop with sync executions. We know that it's important these
    // functions are retried indefinitely but if it's called synchronously we will
    // not have time to receive data or updates.
    //
    var next = one(function force(err, data) {
      if (!node.timers) return; // We're been destroyed, ignore all.

      node.timers.setImmediate(uuid +'@async', function async() {
        if (err) {
          node.emit('error', err);
          return again();
        }

        fn(data);
      });
    });

    //
    // Ensure that the assigned callback has the same context as our node.
    //
    attempt.call(node, next);

    node.timers.setTimeout(uuid, function timeoutfn() {
      next(new Error('Timed out, attempting to retry again'));
    }, +timeout || node.timeout());
  }());

  return this;
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
  duration = duration || this.beat;

  if (this.timers.active('heartbeat')) {
    this.timers.adjust('heartbeat', duration);
    return this;
  }

  this.timers.setTimeout('heartbeat', function heartbeattimeout() {
    if (Node.LEADER !== this.state) {
      this.emit('heartbeat timeout');
      return this.promote();
    }

    //
    // According to the raft spec we should be sending empty append requests as
    // heartbeat. We want to emit an event so people can modify or inspect the
    // payload before we send it. It's also a good indication for when the
    // idle state of a LEADER as it didn't get any messages to append/commit to
    // the FOLLOWER'S.
    //
    var packet = this.packet('append');

    this.emit('heartbeat', packet);
    this.message(Node.FOLLOWER, packet).heartbeat(this.beat);
  }, duration);

  return this;
};

/**
 * Send a message to connected nodes within our cluster. The following messaging
 * patterns (who) are available:
 *
 * - Node.LEADER   : Send a message to cluster's current leader.
 * - Node.FOLLOWER : Send a message to all non leaders.
 * - Node.CHILD    : Send a message to everybody.
 * - <address>     : Send a message to a node based on the address.
 *
 * @param {Mixed} who Recipient of the message.
 * @param {Mixed} what The data we need to send.
 * @param {Function} when Completion callback
 * @returns {Node}
 * @api public
 */
Node.prototype.message = function message(who, what, when) {
  when = when || nope;

  var length = this.nodes.length
    , latency = []
    , node = this
    , nodes = []
    , i = 0;

  switch (who) {
    case Node.LEADER: for (; i < length; i++)
      if (node.leader === node.nodes[i].address) {
        nodes.push(node.nodes[i]);
      }
    break;

    case Node.FOLLOWER: for (; i < length; i++)
      if (node.leader !== node.nodes[i].address) {
        nodes.push(node.nodes[i]);
      }
    break;

    case Node.CHILD:
      Array.prototype.push.apply(nodes, node.nodes);
    break;

    default: for (; i < length; i++)
      if (who === node.nodes[i].address) {
        nodes.push(node.nodes[i]);
      }
  }

  /**
   * A small wrapper to force indefinitely sending of a certain packet.
   *
   * @param {Node} client Node we need to write a message to.
   * @param {Object} data Message that needs to be send.
   * @api private
   */
  function wrapper(client, data) {
    var start = +new Date();

    client.write(data, function written(err, data) {
      latency.push(+new Date() - start);

      //
      // OK, so this is the strange part here. We've broadcasted messages and
      // got replies back. This reply contained data so we need to process it.
      // What if the data is incorrect? Then we have no way at the moment to
      // send back reply to a reply to the server.
      //
      if (err) node.emit('error', err);
      else if (data) node.emit('data', data);

      //
      // Messaging has been completed.
      //
      if (latency.length === length) {
        node.timing(latency);
      }
    });
  }

  length = nodes.length;
  i = 0;

  for (; i < length; i++) {
    wrapper(nodes[i], what);
  }

  return node;
};

/**
 * Generate the various of timeouts.
 *
 * @returns {Number}
 * @api private
 */
Node.prototype.timeout = function timeout() {
  var times = this.election;

  return Math.floor(Math.random() * (times.max - times.min + 1) + times.min);
};

/**
 * Calculate if our average latency causes us to come dangerously close to the
 * minimum election timeout.
 *
 * @param {Array} latency Latency of the last broadcast.
 * @param {Boolean} Success-fully calculated the threshold.
 * @api private
 */
Node.prototype.timing = function timing(latency) {
  if (Node.STOPPED === this.state) return false;

  for (var i = 0, sum = 0; i < latency.length; i++) {
    sum += latency[i];
  }

  this.latency = Math.floor(sum / latency.length);

  if (this.latency > this.election.min * this.threshold) {
    this.emit('threshold');
  }

  return true;
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
  this.votes.for = this.address;
  this.votes.granted = 1;

  //
  // Broadcast the voting request to all connected nodes in your private
  // cluster.
  //
  var packet = this.packet('vote')
    , i = 0;

  this.message(Node.FOLLOWER, this.packet('vote'));

  //
  // Set the election timeout. This gives the nodes some time to reach
  // consensuses about who they want to vote for. If no consensus has been
  // reached within the set timeout we will attempt it again.
  //
  this.timers
    .clear('heartbeat, election')
    .setTimeout('election', this.promote, this.timeout());

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
    state:   this.state,    // So you know if we're a leader, candidate or follower.
    term:    this.term,     // Our current term so we can find mis matches.
    address: this.address,  // Adress of the sender.
    type:    type,          // Message type.
    leader:  this.leader,   // Who is our leader.
  };

  //
  // If we have logging and state replication enabled we also need to send this
  // additional data so we can use it determine the state of this node.
  //
  // @TODO point to index of last commit entry.
  // @TODO point to term of last commit entry.
  //
  if (this.log) packet.last = { term: this.term, index: this.log.index };
  if (arguments.length === 2) packet.data = data;

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
    'Log':            this.Log,
    'election max':   this.election.max,
    'election min':   this.election.min,
    'heartbeat':      this.beat,
    'threshold':      this.threshold,
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
 * @param {String} address The address of the node that is connected.
 * @param {Function} write A method that we use to write data.
 * @returns {Node} The node we created and that joined our cluster.
 * @api public
 */
Node.prototype.join = function join(address, write) {
  if ('function' === this.type(address)) {
    write = address; address = null;
  }

  //
  // You shouldn't be able to join the cluster as your self. So we're going to
  // add a really simple address check here. Return nothing so people can actually
  // check if a node has been added.
  //
  if (this.address === address) return;

  var node = this.clone({
    write: write,       // Optional function that receives our writes.
    address: address,   // A custom address for the node we added.
    state: Node.CHILD   // We are a node in the cluster.
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
 * @param {String} address The address of the node that should be removed.
 * @returns {Node} The node that we removed.
 * @api public
 */
Node.prototype.leave = function leave(address) {
  var index = -1
    , node;

  for (var i = 0; i < this.nodes.length; i++) {
    if (this.nodes[i] === address || this.nodes[i].address === address) {
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
Node.prototype.end = Node.prototype.destroy = function end() {
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
