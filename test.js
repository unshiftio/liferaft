/* istanbul ignore next */
describe('liferaft', function () {
  'use strict';

  var assume = require('assume')
    , Raft = require('./')
    , raft;

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

  it('is extendible', function () {
    assume(Raft.extend).is.a('function');
  });

  describe('initialization', function () {
    it('can be constructed without `new`', function () {
      raft.end();
      raft = Raft();
      assume(raft).is.instanceOf(Raft);
    });

    it('accepts strings for election and heartbeat', function () {
      raft.end();
      raft = new Raft({
        'election min': '100 ms',
        'election max': '150 ms',
        'heartbeat min': '400 ms',
        'heartbeat max': '600 ms'
      });

      assume(raft.beat.max).equals(600);
      assume(raft.beat.min).equals(400);
      assume(raft.election.max).equals(150);
      assume(raft.election.min).equals(100);

      raft.end();
      raft = new Raft({
        'election min': 100,
        'election max': 150,
        'heartbeat min': 400,
        'heartbeat max': 600
      });

      assume(raft.beat.max).equals(600);
      assume(raft.beat.min).equals(400);
      assume(raft.election.max).equals(150);
      assume(raft.election.min).equals(100);
    });

    it('sets a unique name by default', function () {
      var another = new Raft();

      assume(raft.name).does.not.equal(another.name);
      another.end();
    });

    it('can set a custom name', function () {
      raft.end();
      raft = new Raft({ name: 'foo' });

      assume(raft.name).equals('foo');
    });

    it('accepts the name as first argument', function () {
      raft.end();

      raft = new Raft('foo');
      assume(raft.name).equals('foo');
    });

    it('will call the initialization function if exists', function (next) {
      var MyRaft = Raft.extend({
        initialize: function () {
          var node = this;

          setTimeout(function () {
            node.end();
            next();
          }, 0);
        }
      });

      new MyRaft();
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

  describe('#broadcast', function () {
    it('calls all joined nodes', function (next) {
      var pattern = '';

      raft.join(function () { pattern += 'a'; });
      raft.join(function () { pattern += 'b'; });
      raft.join(function () { pattern += 'c'; });

      raft.broadcast(raft.packet('foo'), 1000);

      setTimeout(function () {
        assume(pattern).equals('abc');
        next();
      }, 20);
    });

    it('attempts writing packet again if write failed', function (next) {
      var packet = raft.packet('foo')
        , called = false;

      raft.join(function (data, fn) {
        assume(fn).is.a('function');
        assume(data).equal(packet);

        if (!called) {
          called = true;
          return fn(new Error('I failed to process fn'));
        }

        next();
      });

      raft.broadcast(packet);
    });

    it('emits the `data` event with response', function (next) {
      var node = raft.join(function (data, fn) {
        fn(undefined, node.packet('external'));
      });

      raft.on('rpc', function (packet) {
        assume(packet.type).equals('external');
        assume(packet.name).equals(node.name);
        assume(raft.name).does.not.equal(node.name);

        next();
      });

      raft.broadcast(raft.packet('foo'));
    });
  });

  describe('#timeout', function () {
    it('generates a random timeout between min/max', function () {
      var timeouts = []
        , times = 100
        , same = {};

      for (var i = 0; i < times; i++) {
        timeouts.push(raft.timeout('election'));
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
      raft.leader = raft.name;
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

      assume(raft.votes.for).equals(raft.name);
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

      assume(obj.name).is.a('string');
      assume(obj.name).equals(raft.name);

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
    });

    it('returns instance of a custom instance', function () {
      raft.end();

      var Draft = Raft.extend({ write: function () { } })
        , draft = new Draft();

      assume(draft.clone()).is.instanceOf(Draft);
      assume(draft.clone()).is.instanceOf(Raft);

      draft.end();
    });

    it('inherits the options', function () {
      raft.end();

      var Draft = Raft.extend({ write: function () { } })
        , draft = new Draft({ threshold: 99 })
        , punk = draft.clone();

      assume(punk.threshold).equals(99);

      punk.end();
      draft.end();
    });

    it('allows overriding of config through options', function () {
      raft.end();

      var Draft = Raft.extend({ write: function () { } })
        , draft = new Draft({ threshold: 99 })
        , punk = draft.clone({ threshold: 9 });

      assume(punk.threshold).equals(9);

      punk.end();
      draft.end();
    });
  });

  describe('#join', function () {
    it('returns the node we added', function () {
      var node = raft.join();

      assume(node.name).does.not.equal(raft.name);
      assume(node).does.not.equal(raft);
      assume(node).is.instanceOf(Raft);

      node.end();
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

      var Draft = Raft.extend({ write: function () { } })
        , draft = new Draft({ threshold: 99 })
        , punk = draft.join('foo');

      assume(punk).is.instanceOf(Draft);
      assume(punk).is.instanceOf(Raft);
      assume(punk).does.not.equal(draft);

      punk.end();
      draft.end();
    });

    it('allows setting of node with a custom name', function () {
      var node = raft.join('foo');

      assume(node).does.not.equal(raft);
      assume(node).is.instanceOf(Raft);
      assume(node.name).equals('foo');

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

        raft.votes.for = raft.name;
        raft.votes.granted++;

        raft.change({ term: 2 });
      });
    });

    describe('data', function () {
      it('calls the callback for unknown messages', function (next) {
        raft.emit('data', { type: 'bar' }, function (err) {
          assume(err).is.instanceOf(Error);
          next();
        });
      });

      it('calls with an error when invalid data is send', function (next) {
        raft.emit('data', 1, function (err) {
          assume(err).is.instanceOf(Error);
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

    describe('rpc', function () {
      it('should emit an rpc event when an unknown package arrives', function (next) {
        raft.once('rpc', function (packet) {
          assume(packet.type).equals('shizzle');
          next();
        });

        raft.emit('data', raft.packet('shizzle'));
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
            name: 'vladimir',
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
          raft.emit('data', { name: 'vladimir', term: raft.term, type: 'vote' });
          raft.emit('data', { name: 'anatoly', term: raft.term, type: 'vote' });
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
            name: 'foobar',
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
            name: 'foobar',
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
            name: 'foobar',
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
              name: 'foobar',
              type: 'voted'
            });
          }

          assume(raft.state).equals(Raft.LEADER);
        });
      });
    });
  });
});
