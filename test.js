/* istanbul ignore next */
describe('liferaft', function () {
  'use strict';

  var assume = require('assume')
    , Raft = require('./')
    , raft;

  beforeEach(function each() {
    raft = new Raft();
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
      assume(Raft()).is.instanceOf(Raft);
    });

    it('accepts strings for election and heartbeat', function () {
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
      assume(raft.name).does.not.equal((new Raft()).name);
    });

    it('can set a custom name', function () {
      raft = new Raft({ name: 'foo' });

      assume(raft.name).equals('foo');
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
      assume(Object.keys(same).length).is.above(70);
    });

    it('uses user supplied timeouts', function () {
      var raft = new Raft({
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
  });

  describe('#change', function () {
    it('updates the term and emits a change', function (next) {
      raft.once('term change', function () {
        assume(raft.term).equals(3);
        next();
      });

      raft.change({ term: 3 });
    });

    it('updates the leader and emits a change', function (next) {
      raft.once('leader change', function () {
        assume(raft.leader).equals('foo');
        next();
      });

      raft.change({ leader: 'foo' });
    });

    it('updates the state and emits a change', function (next) {
      raft.once('state change', function () {
        assume(raft.state).equals(Raft.LEADER);
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
      raft = new Raft({
        'heartbeat min': 100,
        'heartbeat max': 110
      });

      raft.heartbeat();
      setTimeout(function () {
        raft.heartbeat();

        setTimeout(next, 90);
      }, 90);
    });

    it('emits a heartbeat timeout', function (next) {
      raft.once('heartbeat timeout', next);
      raft.heartbeat();
    });

    it('promotes to candidate', function (next) {
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
  });

  //
  // The following set of tests asserts if we correctly follow the Raft white
  // paper and that our module does what is expected of it.
  //
  describe('election', function () {
    describe('vote', function () {
      it('ignores stale votes when term is out of date');
      it('votes on first come first serve basis');
      it('does not vote if already voted');
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
      });

      it('only accepts granted votes');
      it('changes to leader when majority has voted');
    });
  });
});
