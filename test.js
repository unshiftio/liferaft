describe('liferaft', function () {
  'use strict';

  var assume = require('assume')
    , Raft = require('./')
    , raft;

  beforeEach(function each() {
    raft = new Raft(function () {}, function () {});
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

  it('can be constructed without `new`', function () {
    assume(Raft(function () {})).is.instanceOf(Raft);
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
});
