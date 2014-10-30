'use strict';

var setImmediate = require('immediate');

/**
 * The representation of the log of a single node.
 *
 * Options:
 *
 * - `engine` The storage engine that should be used.
 *
 * @constructor
 * @param {Node} node Instance of a node.
 * @param {Object} options Optional configuration.
 * @api public
 */
function Log(node, options) {
  if (!(this instanceof Log)) return new Log(node, options);

  this.node = node;
  this.engine = options.engine || 'memory';

  //
  // Remark: So we want to use something like leveldb here with a particular engine but
  // for now lets just use a silly little array
  // The following would all be stored in a leveldb database. Entries would be
  // its own namespaced key set for easy stream reading and the other values
  // would be stored at their particular key for proper persistence and
  // fetching. These could be used as a cache like thing as well if we wanted
  // faster lookups by default.
  //
  this.commitIndex = 0;
  this.lastApplied = 0;
  this.startIndex = 0;
  this.startTerm = 0;
  this.entries = [];
}

/**
 * Commit a log entry
 *
 * @param {Object} data Data we receive from ourselves or from LEADER
 * @param {function} fn function
 * @api public
 */
Log.prototype.commit = function commit(data, fn) {
  var entry = this.entry(data);

  if (entry) this.append(entry);
  return setImmediate(fn.bind(null, null, !!entry));
};

Log.prototype.append = function append(entry) {
  this.entries.push(entry);
};

/**
 * Return the last entry (this may be async in the future)
 *
 * @returns {Object}
 * @api public
 */
Log.prototype.last = function lastentry() {
  var last = this.entries[this.entries.length - 1];
  if (last) return last;

  return {
    index: this.startIndex,
    term: this.startTerm
  };
};

/**
 * Create a log entry that we will append with correct form and attrs
 *
 * @param {object} Data to compute to a proper entry
 * @api public
 */
Log.prototype.entry = function entry(data) {
  //
  // type of entry, (data/command, or something related to raft itself)
  //
  var type = data.type
    , command = data.command
  //
  // Remark: Hmm this may have to be async if we are fetching everything from a db,
  // lets just keep it in memory for now because we may just preload into cache
  // on startup?
  //
    , index = this.last().index + 1;
  //
  // Remark: How do we want to store function executions or particular actions
  // to be replayed in case necessary?
  //
  return {
    command: command,
    index: index,
    term: this.node.term,
    type: type
  };
};

//
// Expose the log module.
//
module.exports = Log;
