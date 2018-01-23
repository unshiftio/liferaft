const immediate = require('immediate');

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
class Log {
  constructor(node, options) {
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
   * @public
   */
  commit(data, fn) {
    var entry = this.entry(data);

    if (entry) this.append(entry);
    return immediate(fn.bind(null, null, !!entry));
  }

  /**
   * Append a message to the log.
   *
   * @param {Mixed} entry Entry that needs to be appended to the log.
   * @public
   */
  append(entry) {
    this.entries.push(entry);
  }

  /**
   * Return the last entry (this may be async in the future)
   *
   * @returns {Object}
   * @public
   */
  last() {
    var lastentry = this.entries[this.entries.length - 1];
    if (lastentry) return lastentry;

    return {
      index: this.startIndex,
      term: this.startTerm
    };
  }

  /**
   * Create a log entry that we will append with correct form and attrs
   *
   * @param {object} Data to compute to a proper entry
   * @public
   */
  entry(data) {
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
  }

  /**
   * The raft instance we're attached to is closing.
   *
   * @returns {Boolean} First time shutdown.
   * @private
   */
  end() {
    return true;
  }
}

//
// Expose the log module.
//
module.exports = Log;
