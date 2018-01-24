const assume = require('assume');
const Raft = require('../');
const Log = require('../log');

//
// The following set of tests asserts if we correctly follow the Raft white
// paper and that our module does what is expected of it.
//
describe('Raft Consensus Algorithm', function () {
  let raft;

  beforeEach(() => {
    raft = new Raft({
      'heartbeat min': 4000,  // Bump timeout to ensure no false positive
      'heartbeat max': 6000   // so we don't trigger before test timeout
    });
  });

  afterEach(() => {
    raft.end();
  });

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
