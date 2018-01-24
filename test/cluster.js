const assume = require('assume');
const Raft = require('../');
const Log = require('../log');

//
// Batch of tests which tests the clustering capabilities of liferaft as
// everything works different when you start working with massive clusters.
//

/* istanbul ignore next */
describe('cluster', function () {
  var port = 8088
    , net = require('net')
    , debug = require('diagnostics')('cluster');

  class Paddle extends Raft {
    /**
     * Initialize the server so we can receive connections.
     *
     * @param {Object} options Received optiosn when constructing the client.
     * @api private
     */
    initialize(options) {
      var raft = this;

      var server = net.createServer(function incoming(socket) {
        socket.on('data', function (buff) {
          var data = JSON.parse(buff.toString());

          debug(raft.address +':packet#data', data);
          raft.emit('data', data, function reply(data) {
            debug(raft.address +':packet#reply', data);
            socket.write(JSON.stringify(data));
            socket.end();
          });
        });
      }).listen(this.address);

      this.once('end', function end() {
        server.close();
      });
    }

    /**
     * Write to the connection.
     *
     * @param {Object} packet Data to be transfered.
     * @param {Function} fn Completion callback.
     * @api public
     */
    write(packet, fn) {
      var socket = net.connect(this.address)
        , raft = this;

      debug(raft.address +':packet#write', packet);
      socket.on('error', fn);
      socket.on('data', function (buff) {
        var data;

        try { data = JSON.parse(buff.toString()); }
        catch (e) { return fn(e); }

        debug(raft.address +':packet#callback', packet);
        fn(undefined, data);
      });

      socket.setNoDelay(true);
      socket.write(JSON.stringify(packet));
    }
  }

  it.skip('reaches consensus about leader election', function (next) {
    var ports = [port++, port++, port++, port++]
      , nodes = []
      , node
      , i
      , j;

    for (i = 0; i < ports.length; i++) {
      node = new Paddle(ports[i]);
      nodes.push(node);

      for (j = 0; j < ports.length; j++) {
        if (ports[j] === ports[i]) continue;

        node.join(ports[j]);
      }
    }

    for (i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) continue;

      nodes[i].once('state change', function (to, from) {
        throw new Error('I should not change state, im a follower');
      });

      nodes[i].on('leader change', function (to, from) {
        assume(to).equals(node.address);
      });
    }

    //
    // Force a node in to a candidate role to ensure that this node will be
    // promoted as leader as it's the first to be alive.
    //
    node.promote();
    node.once('state change', function changed(state) {
      assume(state).equals(Paddle.LEADER);

      //
      // Check if every node is in sync
      //
      for (i = 0; i < nodes.length; i++) {
        if (node === nodes[i]) continue;

        assume(nodes[i].leader).equals(node.address);
        assume(nodes[i].state).equals(Raft.FOLLOWER);
        assume(nodes[i].term).equals(node.term);
      }

      for (i = 0; i < ports.length; i++) {
        nodes[i].end();
      }

      next();
    });
  });
});
