'use strict';

var debug = require('diagnostics')('raft')
  , argv = require('argh').argv
  , LifeRaft = require('../')
  , msg;

if (argv.queue) msg = require(argv.queue);
else msg = require('axon');

//
// We're going to create own custom Raft instance which is powered by axon for
// communication purposes. But you can also use things like HTTP, OMQ etc.
//
var MsgRaft = LifeRaft.extend({
  /**
   * Reference our socket.
   *
   * @type {Msg}
   * @private
   */
  socket: null,

  /**
   * Initialized, start connecting all the things.
   *
   * @param {Object} options Options.
   * @api private
   */
  initialize: function initialize(options) {
    var raft = this
      , socket;

    debug('initializing reply socket on port %s', raft.address);

    socket = raft.socket = msg.socket('rep');

    socket.bind(raft.address);
    socket.on('message', function (data, fn) {
      raft.emit('data', data, fn);
    });

    socket.on('error', function err() {
      debug('failed to initialize on port: ', raft.address);
    });
  },

  /**
   * The message to write.
   *
   * @param {Object} packet The packet to write to the connection.
   * @param {Function} fn Completion callback.
   * @api private
   */
  write: function write(packet, fn) {
    var raft = this
      , socket = raft.socket;

    if (!socket) {
      socket = raft.socket = msg.socket('req');

      socket.connect(raft.address);
      socket.on('error', function err() {
        console.error('failed to write to: ', raft.address);
      });
    }

    debug('writing packet to socket on port %s', raft.address);
    socket.send(packet, function (data) {
      fn(undefined, data);
    });
  }
});

//
// We're going to start with a static list of servers. A minimum cluster size is
// 4 as that only requires majority of 3 servers to have a new leader to be
// assigned. This allows the failure of one single server.
//
var ports = [
  8081, 8082,
  8083, 8084,
  8085, 8086
];

//
// The port number of this Node process.
//
var port = +argv.port || ports[0];

//
// Now that we have all our variables we can safely start up our server with our
// assigned port number.
//
var raft = new MsgRaft('tcp://127.0.0.1:'+ port, {
  'election min': 2000,
  'election max': 5000,
  'heartbeat': 1000
});

raft.on('heartbeat timeout', function () {
  debug('heart beat timeout, starting election');
});

raft.on('term change', function (to, from) {
  debug('were now running on term %s -- was %s', to, from);
}).on('leader change', function (to, from) {
  debug('we have a new leader to: %s -- was %s', to, from);
}).on('state change', function (to, from) {
  debug('we have a state to: %s -- was %s', to, from);
});

raft.on('leader', function () {
  console.log('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@');
  console.log('I am elected as leader');
  console.log('@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@');
});

raft.on('candidate', function () {
  console.log('----------------------------------');
  console.log('I am starting as candidate');
  console.log('----------------------------------');
});

//
// Join in other nodes so they start searching for each other.
//
ports.forEach(function join(nr) {
  if (!nr || port === nr) return;

  raft.join('tcp://127.0.0.1:'+ nr);
});
