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
 * Representation of a single raft node in the cluster.
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
 * `Raft#join` method so it will correctly copy the new option to the clone as
 * well.
 *
 * @constructor
 * @param {Mixed} address Unique address, id or name of this given raft node.
 * @param {Object} options Raft configuration.
 * @api public
 */
function Raft(address, options) {
  var raft = this;

  if (!(raft instanceof Raft)) return new Raft(options);

  options = options || {};

  if ('object' === typeof address) options = address;
  else if (!options.address) options.address = address;

  raft.election = {
    min: Tick.parse(options['election min'] || '150 ms'),
    max: Tick.parse(options['election max'] || '300 ms')
  };

  raft.beat = Tick.parse(options.heartbeat || '50 ms');

  raft.votes = {
    for: null,                // Who did we vote for in this current term.
    granted: 0                // How many votes we're granted to us.
  };

  raft.write = raft.write || options.write || null;
  raft.threshold = options.threshold || 0.8;
  raft.address = options.address || UUID();
  raft.timers = new Tick(raft);
  raft.Log = options.Log;
  raft.latency = 0;
  raft.log = null;
  raft.nodes = [];

  //
  // Raft §5.2:
  //
  // When a server starts, it's always started as Follower and it will remain in
  // this state until receive a message from a Leader or Candidate.
  //
  raft.state = options.state || Raft.FOLLOWER;    // Our current state.
  raft.leader = '';                               // Leader in our cluster.
  raft.term = 0;                                  // Our current term.

  raft._initialize(options);
}

//
// Add some sugar and spice and everything nice. Oh, and also inheritance.
//
Raft.extend = require('extendible');
Raft.prototype = new EventEmitter();
Raft.prototype.constructor = Raft;
Raft.prototype.emits = require('emits');

/**
 * Raft §5.1:
 *
 * A Raft can be in only one of the various states. The stopped state is not
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
Raft.states = 'STOPPED,LEADER,CANDIDATE,FOLLOWER,CHILD'.split(',');
for (var s = 0; s < Raft.states.length; s++) {
  Raft[Raft.states[s]] = s;
}

/**
 * Initialize Raft and start listening to the various of events we're
 * emitting as we're quite chatty to provide the maximum amount of flexibility
 * and reconfigurability.
 *
 * @param {Object} options The configuration you passed in the constructor.
 * @api private
 */
Raft.prototype._initialize = function initializing(options) {
  var raft = this;

  //
  // Reset our vote as we're starting a new term. Votes only last one term.
  //
  raft.on('term change', function change() {
    raft.votes.for = null;
    raft.votes.granted = 0;
  });

  //
  // Reset our times and start the heartbeat again. If we're promoted to leader
  // the heartbeat will automatically be broadcasted to users as well.
  //
  raft.on('state change', function change(state) {
    raft.timers.clear('heartbeat, election');
    raft.heartbeat(Raft.LEADER === raft.state ? raft.beat : raft.timeout());
    raft.emit(Raft.states[state].toLowerCase());
  });

  //
  // Receive incoming messages and process them.
  //
  raft.on('data', function incoming(packet, write) {
    write = write || nope;
    var reason;

    if ('object' !== raft.type(packet)) {
      reason = 'Invalid packet received';
      raft.emit('error', new Error(reason));
      return write(raft.packet('error', reason));
    }

    //
    // Raft §5.1:
    //
    // Applies to all states. If a response contains a higher term then our
    // current term need to change our state to FOLLOWER and set the received
    // term.
    //
    // If the raft receives a request with a stale term number it should be
    // rejected.
    //
    if (packet.term > raft.term) {
      raft.change({
        leader: Raft.LEADER === packet.state ? packet.address : packet.leader || raft.leader,
        state: Raft.FOLLOWER,
        term: packet.term
      });
    } else if (packet.term < raft.term) {
      reason = 'Stale term detected, received `'+ packet.term +'` we are at '+ raft.term;
      raft.emit('error', new Error(reason));
      return write(raft.packet('error', reason));
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
    if (Raft.LEADER === packet.state) {
      if (Raft.FOLLOWER !== raft.state) raft.change({ state: Raft.FOLLOWER });
      if (packet.address !== raft.leader) raft.change({ leader: packet.address });

      //
      // Always when we receive an message from the Leader we need to reset our
      // heartbeat.
      //
      raft.heartbeat(raft.timeout());
    }

    switch (packet.type) {
      //
      // Raft §5.2:
      // Raft §5.4:
      //
      // A raft asked us to vote on them. We can only vote to them if they
      // represent a higher term (and last log term, last log index).
      //
      case 'vote':
        //
        // The term of the vote is bigger then ours so we need to update it. If
        // it's the same and we already voted, we need to deny the vote.
        //
        if (raft.votes.for && raft.votes.for !== packet.address) {
          raft.emit('vote', packet, false);
          return write(raft.packet('voted', { granted: false }));
        }

        //
        // If we maintain a log, check if the candidates log is as up to date as
        // ours.
        //
        // @TODO point to index of last commit entry.
        // @TODO point to term of last commit entry.
        //
        if (raft.log && packet.last && (
             raft.log.index > packet.last.index
          || raft.term > packet.last.term
        )) {
          raft.emit('vote', packet, false);
          return write(raft.packet('voted', { granted: false }));
        }

        //
        // We've made our decision, we haven't voted for this term yet and this
        // candidate came in first so it gets our vote as all requirements are
        // met.
        //
        raft.votes.for = packet.address;
        raft.emit('vote', packet, true);
        raft.change({ leader: packet.address, term: packet.term });
        write(raft.packet('voted', { granted: true }));

        //
        // We've accepted someone as potential new leader, so we should reset
        // our heartbeat to prevent this raft from timing out after voting.
        // Which would again increment the term causing us to be next CANDIDATE
        // and invalidates the request we just got, so that's silly willy.
        //
        raft.heartbeat(raft.timeout());
      break;

      //
      // A new incoming vote.
      //
      case 'voted':
        //
        // Only accepts votes while we're still in a CANDIDATE state.
        //
        if (Raft.CANDIDATE !== raft.state) {
          return write(raft.packet('error', 'No longer a candidate, ignoring vote'));
        }

        //
        // Increment our received votes when our voting request has been
        // granted by the raft that received the data.
        //
        if (packet.data.granted) {
          raft.votes.granted++;
        }

        //
        // Check if we've received the minimal amount of votes required for this
        // current voting round to be considered valid.
        //
        if (raft.quorum(raft.votes.granted)) {
          raft.change({ leader: raft.address, state: Raft.LEADER });

          //
          // Send a heartbeat message to all connected clients.
          //
          raft.message(Raft.FOLLOWER, raft.packet('append'));
        }

        //
        // Empty write, nothing to do.
        //
        write();
      break;

      case 'error':
        raft.emit('error', new Error(packet.data));
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
        if (raft.listeners('rpc').length) {
          raft.emit('rpc', packet, write);
        } else {
          write(raft.packet('error', 'Unknown message type: '+ packet.type));
        }
    }
  });

  //
  // We do not need to execute the rest of the functionality below as we're
  // currently running as "child" raft of the cluster not as the "root" raft.
  //
  if (Raft.CHILD === raft.state) return raft.emit('initialize');

  //
  // Setup the log & appends. Assume that if we're given a function log that it
  // needs to be initialized as it requires access to our raft instance so it
  // can read our information like our leader, state, term etc.
  //
  if ('function' === raft.type(raft.Log)) {
    raft.log = new raft.Log(raft, options);
  }

  /**
   * The raft is now listening to events so we can start our heartbeat timeout.
   * So that if we don't hear anything from a leader we can promote our selfs to
   * a candidate state.
   *
   * Start listening listening for heartbeats when implementors are also ready
   * with setting up their code.
   *
   * @api private
   */
  function initialize(err) {
    if (err) return raft.emit('error', err);

    raft.emit('initialize');
    raft.heartbeat(raft.timeout());
  }

  if ('function' === raft.type(raft.initialize)) {
    if (raft.initialize.length > 1) return raft.initialize(options, initialize);
    raft.initialize(options);
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
Raft.prototype.type = function type(of) {
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
Raft.prototype.quorum = function quorum(responses) {
  if (!this.nodes.length || !responses) return false;

  return responses >= this.majority();
};

/**
 * The majority required to reach our the quorum.
 *
 * @returns {Number}
 * @api public
 */
Raft.prototype.majority = function majority() {
  return Math.ceil(this.nodes.length / 2) + 1;
};

/**
 * Attempt to run a function indefinitely until the callback is called.
 *
 * @param {Function} attempt Function that needs to be attempted.
 * @param {Function} fn Completion callback.
 * @param {Number} timeout Which timeout should we use.
 * @returns {Raft}
 * @api public
 */
Raft.prototype.indefinitely = function indefinitely(attempt, fn, timeout) {
  var uuid = UUID()
    , raft = this;

  (function again() {
    //
    // We need to force async execution here because we do not want to saturate
    // the event loop with sync executions. We know that it's important these
    // functions are retried indefinitely but if it's called synchronously we will
    // not have time to receive data or updates.
    //
    var next = one(function force(err, data) {
      if (!raft.timers) return; // We're been destroyed, ignore all.

      raft.timers.setImmediate(uuid +'@async', function async() {
        if (err) {
          raft.emit('error', err);
          return again();
        }

        fn(data);
      });
    });

    //
    // Ensure that the assigned callback has the same context as our raft.
    //
    attempt.call(raft, next);

    raft.timers.setTimeout(uuid, function timeoutfn() {
      next(new Error('Timed out, attempting to retry again'));
    }, +timeout || raft.timeout());
  }());

  return this;
};

/**
 * Process a change in the raft.
 *
 * @param {Object} changed Data that is changed.
 * @returns {Raft}
 * @api private
 */
Raft.prototype.change = function change(changed) {
  var changes = ['term', 'leader', 'state']
    , currently, previously
    , raft = this
    , i = 0;

  if (!changed) return raft;

  for (; i < changes.length; i++) {
    if (changes[i] in changed && changed[changes[i]] !== raft[changes[i]]) {
      currently = changed[changes[i]];
      previously = raft[changes[i]];

      raft[changes[i]] = currently;
      raft.emit(changes[i] +' change', currently, previously);
    }
  }

  return raft;
};

/**
 * Start or update the heartbeat of the Raft. If we detect that we've received
 * a heartbeat timeout we will promote our selfs to a candidate to take over the
 * leadership.
 *
 * @param {String|Number} duration Time it would take for the heartbeat to timeout.
 * @returns {Raft}
 * @api private
 */
Raft.prototype.heartbeat = function heartbeat(duration) {
  var raft = this;

  duration = duration || raft.beat;

  if (raft.timers.active('heartbeat')) {
    raft.timers.adjust('heartbeat', duration);
    return raft;
  }

  raft.timers.setTimeout('heartbeat', function heartbeattimeout() {
    if (Raft.LEADER !== raft.state) {
      raft.emit('heartbeat timeout');
      return raft.promote();
    }

    //
    // According to the raft spec we should be sending empty append requests as
    // heartbeat. We want to emit an event so people can modify or inspect the
    // payload before we send it. It's also a good indication for when the
    // idle state of a LEADER as it didn't get any messages to append/commit to
    // the FOLLOWER'S.
    //
    var packet = raft.packet('append');

    raft.emit('heartbeat', packet);
    raft.message(Raft.FOLLOWER, packet).heartbeat(raft.beat);
  }, duration);

  return raft;
};

/**
 * Send a message to connected nodes within our cluster. The following messaging
 * patterns (who) are available:
 *
 * - Raft.LEADER   : Send a message to cluster's current leader.
 * - Raft.FOLLOWER : Send a message to all non leaders.
 * - Raft.CHILD    : Send a message to everybody.
 * - <address>     : Send a message to a raft based on the address.
 *
 * @param {Mixed} who Recipient of the message.
 * @param {Mixed} what The data we need to send.
 * @param {Function} when Completion callback
 * @returns {Raft}
 * @api public
 */
Raft.prototype.message = function message(who, what, when) {
  when = when || nope;

  var length = this.nodes.length
    , latency = []
    , raft = this
    , nodes = []
    , i = 0;

  switch (who) {
    case Raft.LEADER: for (; i < length; i++)
      if (raft.leader === raft.nodes[i].address) {
        nodes.push(raft.nodes[i]);
      }
    break;

    case Raft.FOLLOWER: for (; i < length; i++)
      if (raft.leader !== raft.nodes[i].address) {
        nodes.push(raft.nodes[i]);
      }
    break;

    case Raft.CHILD:
      Array.prototype.push.apply(nodes, raft.nodes);
    break;

    default: for (; i < length; i++)
      if (who === raft.nodes[i].address) {
        nodes.push(raft.nodes[i]);
      }
  }

  /**
   * A small wrapper to force indefinitely sending of a certain packet.
   *
   * @param {Raft} client Raft we need to write a message to.
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
      if (err) raft.emit('error', err);
      else if (data) raft.emit('data', data);

      //
      // Messaging has been completed.
      //
      if (latency.length === length) {
        raft.timing(latency);
      }
    });
  }

  length = nodes.length;
  i = 0;

  for (; i < length; i++) {
    wrapper(nodes[i], what);
  }

  return raft;
};

/**
 * Generate the various of timeouts.
 *
 * @returns {Number}
 * @api private
 */
Raft.prototype.timeout = function timeout() {
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
Raft.prototype.timing = function timing(latency) {
  var raft = this
    , sum = 0
    , i = 0;

  if (Raft.STOPPED === raft.state) return false;

  for (; i < latency.length; i++) {
    sum += latency[i];
  }

  raft.latency = Math.floor(sum / latency.length);

  if (raft.latency > raft.election.min * raft.threshold) {
    raft.emit('threshold');
  }

  return true;
};

/**
 * Raft §5.2:
 *
 * We've detected a timeout from the leaders heartbeats and need to start a new
 * election for leadership. We increment our current term, set the CANDIDATE
 * state, vote our selfs and ask all others rafts to vote for us.
 *
 * @returns {Raft}
 * @api private
 */
Raft.prototype.promote = function promote() {
  var raft = this;

  raft.change({
    state: Raft.CANDIDATE,  // We're now a candidate,
    term: raft.term + 1,    // but only for this term.
    leader: ''              // We no longer have a leader.
  });

  //
  // Candidates are always biased and vote for them selfs first before sending
  // out a voting request to all other rafts in the cluster.
  //
  raft.votes.for = raft.address;
  raft.votes.granted = 1;

  //
  // Broadcast the voting request to all connected rafts in your private
  // cluster.
  //
  var packet = raft.packet('vote')
    , i = 0;

  raft.message(Raft.FOLLOWER, raft.packet('vote'));

  //
  // Set the election timeout. This gives the rafts some time to reach
  // consensuses about who they want to vote for. If no consensus has been
  // reached within the set timeout we will attempt it again.
  //
  raft.timers
    .clear('heartbeat, election')
    .setTimeout('election', raft.promote, raft.timeout());

  return raft;
};

/**
 * Wrap the outgoing messages in an object with additional required data.
 *
 * @param {String} type Message type we're trying to send.
 * @param {Mixed} data Data to be transfered.
 * @returns {Object} Packet.
 * @api private
 */
Raft.prototype.packet = function wrap(type, data) {
  var raft = this
    , packet = {
      state:   raft.state,    // Are we're a leader, candidate or follower.
      term:    raft.term,     // Our current term so we can find mis matches.
      address: raft.address,  // Adress of the sender.
      type:    type,          // Message type.
      leader:  raft.leader,   // Who is our leader.
    };

  //
  // If we have logging and state replication enabled we also need to send this
  // additional data so we can use it determine the state of this raft.
  //
  // @TODO point to index of last commit entry.
  // @TODO point to term of last commit entry.
  //
  if (raft.log) packet.last = { term: raft.term, index: raft.log.index };
  if (arguments.length === 2) packet.data = data;

  return packet;
};

/**
 * Create a clone of the current instance with the same configuration. Ideally
 * for creating connected nodes in a cluster.. And let that be something we're
 * planning on doing.
 *
 * @param {Object} options Configuration that should override the default config.
 * @returns {Raft} The newly created instance.
 * @api public
 */
Raft.prototype.clone = function clone(options) {
  options = options || {};

  var raft = this
    , node = {
      'Log':            raft.Log,
      'election max':   raft.election.max,
      'election min':   raft.election.min,
      'heartbeat':      raft.beat,
      'threshold':      raft.threshold,
    }, key;

  for (key in node) {
    if (key in options || !node.hasOwnProperty(key)) continue;

    options[key] = node[key];
  }

  return new raft.constructor(options);
};

/**
 * A new raft is about to join the cluster. So we need to upgrade the
 * configuration of every single raft.
 *
 * @param {String} address The address of the raft that is connected.
 * @param {Function} write A method that we use to write data.
 * @returns {Raft} The raft we created and that joined our cluster.
 * @api public
 */
Raft.prototype.join = function join(address, write) {
  var raft = this;

  if ('function' === raft.type(address)) {
    write = address; address = null;
  }

  //
  // You shouldn't be able to join the cluster as your self. So we're going to
  // add a really simple address check here. Return nothing so people can actually
  // check if a raft has been added.
  //
  if (raft.address === address) return;

  var node = raft.clone({
    write: write,       // Optional function that receives our writes.
    address: address,   // A custom address for the raft we added.
    state: Raft.CHILD   // We are a raft in the cluster.
  });

  node.once('end', function end() {
    raft.leave(node);
  }, raft);

  raft.nodes.push(node);
  raft.emit('join', node);

  return node;
};

/**
 * Remove a raft from the cluster.
 *
 * @param {String} address The address of the raft that should be removed.
 * @returns {Raft} The raft that we removed.
 * @api public
 */
Raft.prototype.leave = function leave(address) {
  var raft = this
    , index = -1
    , node;

  for (var i = 0; i < raft.nodes.length; i++) {
    if (raft.nodes[i] === address || raft.nodes[i].address === address) {
      node = raft.nodes[i];
      index = i;
      break;
    }
  }

  if (~index && node) {
    if (node.end) node.end();

    raft.nodes.splice(index, 1);
    raft.emit('leave', node);
  }

  return node;
};

/**
 * This Raft needs to be shut down.
 *
 * @returns {Boolean} Successful destruction.
 * @api public
 */
Raft.prototype.end = Raft.prototype.destroy = function end() {
  var raft = this;

  if (Raft.STOPPED === raft.state) return false;
  raft.state = Raft.STOPPED;

  if (raft.nodes.length) for (var i = 0; i < raft.nodes.length; i++) {
    raft.leave(raft.nodes[i]);
  }

  raft.emit('end');
  raft.timers.end();
  raft.removeAllListeners();

  if (raft.log) raft.log.end();
  raft.timers = raft.log = raft.Log = raft.beat = raft.election = null;

  return true;
};

//
// Expose the module interface.
//
module.exports = Raft;
