const assume = require('assume');
const Raft = require('./');

/* istanbul ignore next */
describe('liferaft', function () {
  'use strict';

  var raft;

  beforeEach(function each() {
    raft = new Raft({
      'heartbeat min': 4000,  // Bump timeout to ensure no false positive
      'heartbeat max': 6000   // so we don't trigger before test timeout
    });
  });

  afterEach(function each() {
    raft.end();
  });

  it('is exposed a function', function () {
    assume(Raft).is.a('function');
  });

  describe('initialization', function () {
    it('accepts strings for election and heartbeat', function () {
      raft.end();

      raft = new Raft({
        'election min': '100 ms',
        'election max': '150 ms',
        'heartbeat': '600 ms'
      });

      assume(raft.beat).equals(600);
      assume(raft.election.max).equals(150);
      assume(raft.election.min).equals(100);

      raft.end();

      raft = new Raft({
        'election min': 100,
        'election max': 150,
        'heartbeat': 600
      });

      assume(raft.beat).equals(600);
      assume(raft.election.max).equals(150);
      assume(raft.election.min).equals(100);
    });

    it('sets a unique address by default', function () {
      const another = new Raft();

      assume(raft.address).does.not.equal(another.address);
      another.end();
    });

    it('can set a custom address', function () {
      raft.end();

      raft = new Raft({ address: 'foo' });

      assume(raft.address).equals('foo');
    });

    it('accepts the address as first argument', function () {
      raft.end();

      raft = new Raft('foo');
      assume(raft.address).equals('foo');
    });

    it('will call the initialization function if exists', function (next) {
      class MyRaft extends Raft {
        initialize() {
          var node = this;

          setTimeout(function () {
            node.end();
            next();
          }, 0);
        }
      }

      new MyRaft();
    });

    it('async emits the initialize event once the initialize method is done', function (next) {
      raft.end();

      var ready = false;

      class MyRaft extends Raft {
        initialize(options, init) {
          assume(options.custom).equals('options');
          assume(ready).is.false();

          setTimeout(function () {
            ready = true;
            init();
          }, 100);
        }
      }

      raft = new MyRaft('foobar', { custom: 'options' });

      raft.on('initialize', function () {
        assume(ready).is.true();

        next();
      });
    });

    it('emits error when the initialize fails', function (next) {
      raft.end();

      class MyRaft extends Raft {
        initialize(options, init) {
          setTimeout(function () {
            init(new Error('Failure'));
          }, 100);
        }
      }

      raft = new MyRaft();

      raft.on('error', function (err) {
        assume(err.message).equals('Failure');

        next();
      });
    });
  });

  describe('#indefinitely', function () {
    it('it runs until the supplied callback is called', function (next) {
      var attempts = 0;

      raft.indefinitely(function attempt(done) {
        attempts++;

        if (attempts === 5) done();
      }, next, 10);
    });

    it('it runs until the supplied callback is called without err', function (next) {
      var attempts = 0;

      raft.indefinitely(function attempt(done) {
        attempts++;

        if (attempts === 5) done();
        else done(new Error('failure'));
      }, next, 10);
    });
  });

  describe('#message', function () {
    it('calls all joined nodes', function (next) {
      var pattern = '';

      raft.join(function () { pattern += 'a'; });
      raft.join(function () { pattern += 'b'; });
      raft.join(function () { pattern += 'c'; });

      raft.message(Raft.FOLLOWER, raft.packet('foo'));

      setTimeout(function () {
        assume(pattern).equals('abc');
        next();
      }, 20);
    });

    it('emits the `data` event with response', function (next) {
      var node = raft.join(function (data, fn) {
        fn(undefined, node.packet('external'));
      });

      raft.on('rpc', function (packet) {
        assume(packet.type).equals('external');
        assume(packet.address).equals(node.address);
        assume(raft.address).does.not.equal(node.address);

        next();
      });

      raft.message(Raft.FOLLOWER, raft.packet('foo'));
    });

    it('sends message to cluster leader', function (next) {
      var leader = raft.join(function (packet) {
        assume(packet.leader).equals(this.address);
        assume(packet.type).equals('leader');

        next();
      });

      raft.join(function () { throw new Error('We are followers, not leader'); });
      raft.join(function () { throw new Error('We are followers, not leader'); });
      raft.join(function () { throw new Error('We are followers, not leader'); });

      raft.change({ leader: leader.address });
      raft.message(Raft.LEADER, raft.packet('leader'));
    });

    it('sends a node specified by address', function (next) {
      raft.join(function () { throw new Error('You sir, msg the wrong node'); });

      var node = raft.join(function (packet) {
        assume(packet.type).equals('address');

        next();
      });

      raft.join(function () { throw new Error('You sir, msg the wrong node'); });
      raft.join(function () { throw new Error('You sir, msg the wrong node'); });
      raft.message(node.address, raft.packet('address'));
    });

    it('throws an error on undefined message', function () {
      assume(function () {
        raft.message(undefined, raft.packet('foo'));
      }).throws('Cannot send message to `undefined`');
    });

    it('runs the `when` callback with no errors', function (next) {
      var node = raft.join(function (data, callback) {
        callback(undefined, 'foo');
      });
      node.address = 'addr';

      raft.message(Raft.FOLLOWER, raft.packet('foo'), function (err, data) {
        assume(err).equals(undefined);
        assume(data).deep.equals({ addr: 'foo' });
        next();
      });
    });

    it('runs the `when` callback with no errors', function (next) {
      var node = raft.join(function (data, callback) {
        callback('bar');
      });
      node.address = 'addr';

      raft.message(Raft.FOLLOWER, raft.packet('foo'), function (err, data) {
        assume(err).deep.equals({ addr: 'bar' });
        assume(data).deep.equals({});
        next();
      });
    });
  });

  describe('#timeout', function () {
    it('generates a random timeout between min/max', function () {
      var timeouts = []
        , times = 100
        , same = {};

      for (var i = 0; i < times; i++) {
        timeouts.push(raft.timeout());
      }

      timeouts.forEach(function (timeout, i) {
        assume(timeout).is.a('number');
        assume(timeout).is.least(raft.election.min);
        assume(timeout).is.most(raft.election.max);

        same[timeout] = same[timeout] || 0;
        same[timeout]++;
      });

      //
      // Ensure that our random generation isn't to damn sucky and can be
      // considered random enough to be workable. This isn't a hard requirement
      // of Raft but still something we need to assert.
      //
      // assume(Object.keys(same).length).is.above(70);
    });

    it('uses user supplied timeouts', function () {
      raft.end();

      raft = new Raft({
        'election min': '300ms',
        'election max': '1s'
      });

      var timeouts = []
        , times = 100;

      for (var i = 0; i < times; i++) {
        timeouts.push(raft.timeout('election'));
      }

      timeouts.forEach(function (timeout, i) {
        assume(timeout).is.a('number');
        assume(timeout).is.least(300);
        assume(timeout).is.most(1000);
      });
    });
  });

  describe('#end', function () {
    function listeners(ee) {
      var amount = 0;
      if (!ee._events) return amount;

      for (var key in ee._events) {
        amount += ee.listeners(key);
      }

      return amount;
    }

    it('returns `true` when destroyed for the first time', function () {
      assume(raft.end()).is.true();
    });

    it('returns `false` when destroyed for the second time', function () {
      assume(raft.end()).is.true();
      assume(raft.end()).is.false();
      assume(raft.end()).is.false();
    });

    it('removes all listeners', function () {
      assume(listeners(raft)).is.above(0);
      assume(raft.end()).to.equal(true);
      assume(listeners(raft)).equals(0);
    });

    it('emits an end event', function (next) {
      raft.on('end', next);

      //
      // Double end is here to check if the event is not executed multiple
      // times.
      //
      raft.end();
      raft.end();
    });

    it('emits an state stopped change', function (next) {
      raft.on('state change', function () {
        assume(raft.state).equals(Raft.STOPPED);
        next();
      });

      raft.end();
    });
  });

  describe('#change', function () {
    it('updates the term and emits a change', function (next) {
      raft.once('term change', function (currently, previously) {
        assume(currently).equals(raft.term);
        assume(previously).equals(0);
        assume(raft.term).equals(3);

        next();
      });

      raft.change({ term: 3 });
    });

    it('updates the leader and emits a change', function (next) {
      raft.once('leader change', function (currently, previously) {
        assume(currently).equals(raft.leader);
        assume(raft.leader).equals('foo');
        assume(previously).equals('');

        next();
      });

      raft.change({ leader: 'foo' });
    });

    it('updates the state and emits a change', function (next) {
      raft.once('state change', function (currently, previously) {
        assume(previously).equals(Raft.FOLLOWER);
        assume(raft.state).equals(Raft.LEADER);
        assume(currently).equals(raft.state);

        next();
      });

      raft.change({ state: Raft.LEADER });
    });

    it('returns this', function () {
      assume(raft.change()).equals(raft);
    });

    it('only a emits change if something changed', function () {
      function heded() { throw new Error('I failed'); }

      raft.once('term change', heded)
          .once('state change', heded)
          .once('leader change', heded);

      raft.change({
        term: raft.term,
        state: raft.state,
        leader: raft.leader
      });

      raft
        .removeListener('leader change', heded)
        .removeListener('state change', heded)
        .removeListener('term change', heded)
    });
  });

  describe('heartbeat', function () {
    it('increments the heartbeat if set before', function (next) {
      raft.end();
      raft = new Raft({ 'heartbeat min': 100, 'heartbeat max': 110 });

      raft.heartbeat();
      setTimeout(function () {
        raft.heartbeat();

        setTimeout(next, 90);
      }, 90);
    });

    it('emits a heartbeat timeout', function (next) {
      raft.end();
      raft = new Raft({ 'heartbeat min': 10, 'heartbeat max': 40 });

      raft.once('heartbeat timeout', next);
      raft.heartbeat();
    });

    it('promotes to candidate', function (next) {
      raft.end();
      raft = new Raft({ 'heartbeat min': 10, 'heartbeat max': 40 });

      raft.once('state change', function () {
        assume(raft.state).equals(Raft.CANDIDATE);
        next();
      });

      raft.heartbeat();
    });

    it('returns this', function () {
      assume(raft.heartbeat()).equals(raft);
      assume(raft.heartbeat()).equals(raft);
    });
  });

  describe('#promote', function () {
    it('changes state to candidate', function () {
      assume(raft.state).does.not.equal(Raft.CANDIDATE);

      raft.promote();
      assume(raft.state).equals(Raft.CANDIDATE);
    });

    it('resets the leader', function () {
      raft.leader = raft.address;
      raft.promote();
      assume(raft.leader).equals('');
    });

    it('increments term', function () {
      raft.term = 40;
      raft.promote();

      assume(raft.term).equals(41);
    });

    it('votes for self', function () {
      assume(raft.votes.for).equals(null);
      assume(raft.votes.granted).equals(0);

      raft.promote();

      assume(raft.votes.for).equals(raft.address);
      assume(raft.votes.granted).equals(1);
    });
  });

  describe('#packet', function () {
    it('wraps the object with common but required data', function () {
      var obj = raft.packet('vote', 'data packet');

      assume(obj).is.a('object');

      assume(obj.state).is.a('number');
      assume(obj.state).equals(Raft.FOLLOWER);

      assume(obj.term).is.a('number');
      assume(obj.term).equals(raft.term);

      assume(obj.address).is.a('string');
      assume(obj.address).equals(raft.address);

      assume(obj.leader).equals(raft.leader);

      assume(obj.type).equals('vote');
      assume(obj.data).equals('data packet');
    });
  });

  describe('#quorum', function () {
    it('needs 7 votes in a cluster of 11', function () {
      raft.nodes.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);

      assume(raft.quorum(7)).is.true();
      assume(raft.quorum(5)).is.false();
    });

    it('return false when there are no nodes', function () {
      assume(raft.quorum(999)).is.false();

      raft.nodes.push(1, 2, 3, 4, 5);
      assume(raft.quorum(0)).is.false();
      assume(raft.quorum(50)).is.true();
      assume(raft.quorum(5)).is.true();
    });
  });

  describe('#majority', function () {
    it('generates an int', function () {
      for (var i = 0; i < 13; i++) {
        raft.nodes.push(i);
        assume(raft.majority() % 1 === 0).is.true();
      }
    });

    it('needs 7 votes in a cluster of 11', function () {
      raft.nodes.push(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
      assume(raft.majority()).equals(7);
    });
  });

  describe('#clone', function () {
    it('returns the created instance', function () {
      var x = raft.clone();

      assume(x).is.instanceOf(Raft);
      x.end();
    });

    it('returns instance of a custom instance', function () {
      raft.end();

      class Draft extends Raft {
        write() {}
      }

      var draft = new Draft()
        , clone = draft.clone();

      assume(clone).is.instanceOf(Draft);
      assume(clone).is.instanceOf(Raft);

      clone.end();
      draft.end();
    });

    it('inherits the options', function () {
      raft.end();

      class Draft extends Raft {
        write() {}
      }

      var draft = new Draft({ threshold: 99 })
        , punk = draft.clone();

      assume(punk.threshold).equals(99);

      punk.end();
      draft.end();
    });

    it('allows overriding of config through options', function () {
      raft.end();

      class Draft extends Raft {
        write() {}
      }

      var draft = new Draft({ threshold: 99 })
        , punk = draft.clone({ threshold: 9 });

      assume(punk.threshold).equals(9);

      punk.end();
      draft.end();
    });
  });

  describe('#join', function () {
    it('returns the node we added', function () {
      assume(raft.nodes.length).equals(0);

      var node = raft.join();

      assume(node.address).does.not.equal(raft.address);
      assume(raft.nodes.length).equals(1);
      assume(node).does.not.equal(raft);
      assume(node).is.instanceOf(Raft);

      node.end();
    });

    it('cannot add a server with the same address as it self', function () {
      assume(raft.nodes.length).equals(0);

      var node = raft.join(raft.address);

      assume(node).is.a('undefined');
      assume(raft.nodes.length).equals(0);
    });

    it('emits an `join` event when a new ode is added', function (next) {
      raft.once('join', function (node) {
        assume(raft.nodes.length).equal(1);
        assume(node).is.instanceOf(Raft);

        node.end();
        next();
      });

      raft.join();
    });

    it('returns the same instance as the node', function () {
      raft.end();

      class Draft extends Raft {
        write() {}
      }

      var draft = new Draft({ threshold: 99 })
        , punk = draft.join('foo');

      assume(punk).is.instanceOf(Draft);
      assume(punk).is.instanceOf(Raft);
      assume(punk).does.not.equal(draft);

      punk.end();
      draft.end();
    });

    it('allows setting of node with a custom address', function () {
      var node = raft.join('foo');

      assume(node).does.not.equal(raft);
      assume(node).is.instanceOf(Raft);
      assume(node.address).equals('foo');

      node.end();
    });

    it('will leave the cluster when ended', function (next) {
      var node = raft.join();

      raft.once('leave', function (left) {
        assume(raft.nodes.length).equals(0);
        assume(node).equals(left);

        next();
      });

      node.end();
    });
  });

  describe('event', function () {
    describe('term change', function () {
      it('resets the votes', function (next) {
        raft.on('term change', function () {
          assume(raft.term).equals(2);
          assume(raft.votes.granted).equals(0);
          assume(!raft.votes.for).is.true();

          next();
        });

        raft.votes.for = raft.address;
        raft.votes.granted++;

        raft.change({ term: 2 });
      });
    });

    describe('data', function () {
      it('calls the callback for unknown messages', function (next) {
        raft.emit('data', { type: 'bar' }, function (err) {
          assume(err).is.not.instanceOf(Error);
          assume(err).is.a('object');
          assume(err.type).equals('error');
          assume(err.data).includes('Unknown');
          next();
        });
      });

      it('calls with an error when invalid data is send', function (next) {
        raft.emit('data', 1, function (err) {
          assume(err).is.not.instanceOf(Error);
          assume(err).is.a('object');
          assume(err.type).equals('error');
          assume(err.data).includes('Invalid');

          next();
        });
      });

      it('updates to FOLLOWER as CANDIDATE when msg by LEADER', function (next) {
        raft.promote();

        raft.once('state change', function () {
          assume(this.state).equals(Raft.FOLLOWER);
          next();
        });

        raft.emit('data', {
          state: Raft.LEADER,
          term: raft.term
        });
      });

      it('automatically update term when ours is out of date', function (next) {
        raft.change({ term : 40 });
        raft.once('term change', function () {
          assume(this.term).equals(41);
          next();
        });

        raft.emit('data', {
          state: Raft.LEADER,
          term: 41
        });
      });
    });

    describe('state events', function () {
      it('should emit a `leader` event', function (next) {
        raft.once('leader', function () {
          next();
        });

        raft.change({ state: Raft.LEADER });
      });

      it('should emit a `follower` event', function (next) {
        raft.once('follower', function () {
          next();
        });

        raft.change({ state: Raft.LEADER }); // Default is follower, so change first
        raft.change({ state: Raft.FOLLOWER });
      });

      it('should emit a `candidate` event', function (next) {
        raft.once('candidate', function () {
          next();
        });

        raft.change({ state: Raft.CANDIDATE });
      });

      it('should emit a `stopped` event', function (next) {
        raft.once('stopped', function () {
          //
          // resetting the state to something else than stopped so that we can
          // actually end the instance as normally this event is not emitted
          // manually.
          //
          raft.change({ state: Raft.FOLLOWER });
          next();
        });

        raft.change({ state: Raft.STOPPED });
      });

      it('should emit a `child` event', function (next) {
        raft.once('child', function () {
          next();
        });

        raft.change({ state: Raft.CHILD });
      });
    });

    describe('rpc', function () {
      it('should emit an rpc event when an unknown package arrives', function (next) {
        raft.once('rpc', function (packet) {
          assume(packet.type).equals('shizzle');
          next();
        });

        raft.emit('data', raft.packet('shizzle'));
      });
    });

    describe('heartbeat', function () {
      it('emits a heartbeat event when we are a leader', function (next) {
        raft.once('heartbeat', function (packet) {
          assume(packet.type).equals('append');
          next();
        });

        raft.change({ state: Raft.LEADER });
        raft.heartbeat();
      });
    });
  });

  //
  // The following set of tests asserts if we correctly follow the Raft white
  // paper and that our module does what is expected of it.
  //
  describe('Raft Consensus Algorithm', function () {
    describe('election', function () {
      describe('vote', function () {
        it('ignores stale votes when term is out of date', function () {
          raft.once('vote', function (packet, accepted) {
            throw new Error('Broken');
          });

          raft.change({ term: 139 });
          raft.emit('data', {
            address: 'vladimir',
            type: 'vote',
            term: 138
          });
        });

        it('votes on first come first serve basis', function (next) {
          raft.once('vote', function (packet, accepted) {
            assume(accepted).is.true();

            raft.once('vote', function (packet, accepted) {
              assume(accepted).is.false();
              next();
            });
          });

          raft.change({ term: 139 });
          raft.emit('data', { address: 'vladimir', term: raft.term, type: 'vote' });
          raft.emit('data', { address: 'anatoly', term: raft.term, type: 'vote' });
        });
      });

      describe('voted', function () {
        it('only increments votes when being a CANDIDATE', function () {
          assume(raft.votes.granted).equals(0);
          assume(raft.state).equals(Raft.FOLLOWER);

          raft.emit('data', {
            data: { granted: true },
            term: raft.term,
            state: Raft.FOLLOWER,
            address: 'foobar',
            type: 'voted'
          });

          assume(raft.votes.granted).equals(0);

          //
          // Promote our selfs to candidate.
          //
          raft.promote();
          assume(raft.state).equals(Raft.CANDIDATE);
          assume(raft.votes.granted).equals(1);

          raft.emit('data', {
            data: { granted: true },
            term: raft.term,
            state: Raft.FOLLOWER,
            address: 'foobar',
            type: 'voted'
          });

          assume(raft.votes.granted).equals(2);
          assume(raft.state).equals(Raft.CANDIDATE);
        });

        it('only accepts granted votes', function () {
          raft.promote();
          assume(raft.state).equals(Raft.CANDIDATE);
          assume(raft.votes.granted).equals(1);

          raft.emit('data', {
            data: { granted: false },
            term: raft.term,
            state: Raft.FOLLOWER,
            address: 'foobar',
            type: 'voted'
          });

          assume(raft.votes.granted).equals(1);
          assume(raft.state).equals(Raft.CANDIDATE);
        });

        it('changes to leader when majority has voted', function (next) {
          //
          // Feed raft some "nodes" so it can actually reach a consensus when it
          // received a majority of the votes.
          //
          raft.nodes.push(
            { write: function () {} },
            { write: function () {} },
            { write: function () {} },
            { write: function () {} },
            { write: function () {} }
          );

          raft.promote();

          raft.once('state change', function (currently, previously) {
            assume(previously).equals(Raft.CANDIDATE);
            assume(raft.state).equals(Raft.LEADER);
            assume(currently).equals(Raft.LEADER);

            next();
          });

          for (var i = 0; i < 4; i++) {
            raft.emit('data', {
              data: { granted: true },
              term: raft.term,
              state: Raft.FOLLOWER,
              address: 'foobar',
              type: 'voted'
            });
          }

          assume(raft.state).equals(Raft.LEADER);
        });
      });
    });
  });

  //
  // Batch of tests which tests the clustering capabilities of liferaft as
  // everything works different when you start working with massive clusters.
  //
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

  describe('bugs', function () {
    it('correctly deletes nodes from the list on leave', function () {
      raft.join('1');
      raft.join('2');
      raft.join('3');

      assume(raft.nodes.length).equals(3);

      raft.leave('2');

      assume(raft.nodes.length).equals(2);
    });
  });
});
