const assume = require('assume');
const Log = require('../log');
const debug = require('diagnostics')('cluster');

describe('Leveldown Log', () => {
  let log;

  beforeEach(() => {
    log = new Log(
      {term: 1, address: 8000},
      {adapter: require('memdown')}
    );

  });

  it('saves and gets', async () => {
    const command = {'first': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command
    });

    const entry = await log.get(1);

    assume(entry.index).equals(1);
    assume(entry.term).equals(1);
    assume(entry.command).deep.equals(command);
  });

  it('get returns error for missing', () => {
    return log.get(10)
    .catch(err => {
      assume(err.notFound).true;
    });
  });

  it('#has returns true for item', async () => {
    const command = {'first': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command
    });

    const resp = log.has({index: 1, term: 1});
    assume(resp).true;

  });

  it('#has returns false for no item', async () => {
    const resp = log.has({index: 1, term: 1});
    assume(resp).false;
  });

  it('#getLastEntry returns last entry', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    await log.put({
      index: 2,
      term: 1,
      command: command2
    });

    const entry = await log.getLastEntry();
    assume(entry.index).equals(2);
    assume(entry.command).deep.equals(command2);
  });

  it('#getLastEntry returns 0 index for empty', async () => {
    const entry = await log.getLastEntry();
    assume(entry.index).equals(0);
  });

  it('#getLastInfo returns last entry', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    await log.put({
      index: 2,
      term: 2,
      command: command2
    });

    const entry = await log.getLastInfo();
    assume(entry.index).equals(2);
    assume(entry.committedIndex).equals(0);
    assume(entry.term).equals(2);
  });

  it('#getLastInfo returns 0 index for empty', async () => {
    const entry = await log.getLastInfo();
    assume(entry.index).equals(0);
  });

  it('#commit commits entry', async () => {
    const command = {'first': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command,
      committed: false
    });

    await log.commit(1);

    const entry = log.get(1);
    assume(entry.committed).true;
  });

  it('#getUncommittedEntriesUpToIndex returns uncommitted entries', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    const command3 = {'third': 'command'};

    await log.put({
      index: 1,
      term: 1,
      command: command1,
      committed: true
    });

    await log.put({
      index: 2,
      term: 2,
      command: command2,
      committed: false
    });

    await log.put({
      index: 3,
      term: 2,
      command: command3,
      committed: false
    });

    const entries = await log.getUncommittedEntriesUpToIndex(3);
    assume(entries.length).equals(2);
    assume(entries[0].command).deep.equals(command2);
    assume(entries[1].command).deep.equals(command3);
  });

  it('#commandAck saves vote for entry', async () => {
    const command = {'first': 'command'};

    await log.put({
      index: 1,
      term: 1,
      command,
      committed: true,
      responses: []
    });

    await log.commandAck(1, 8888);

    const entry = await log.get(1);
    assume(entry.responses.length).equal(1);
    assume(entry.responses[0].address).equal(8888);
    assume(entry.responses[0].ack).equal(true);
  });

  it('#getEntryBefore returns 0 index empty', async () => {
    const command1 = {'first': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    const entry = await log.getEntryBefore({index: 1, term: 1});
    assume(entry.index).equals(0);
  });

  it('#getEntryBefore returns 0 index if none before', async () => {
    const command1 = {'first': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    const entry = await log.getEntryBefore({index: 1, term: 1});
    assume(entry.index).equals(0);
  });

  it('#getEntryBefore returns previous entry', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    const command3 = {'third': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    await log.put({
      index: 2,
      term: 1,
      command: command2
    });

    await log.put({
      index: 3,
      term: 1,
      command: command3
    });

    const entry = await log.getEntryBefore({index: 3, term: 1});
    assume(entry.index).equals(2);
    assume(entry.command).deep.equals(command2);
  });

  it('#getEntryInfo returns previous entry', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    const command3 = {'third': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    await log.put({
      index: 2,
      term: 1,
      command: command2
    });

    await log.put({
      index: 3,
      term: 1,
      command: command3
    });

    const entry = await log.getEntryInfoBefore({index: 3, term: 1});
    assume(entry.index).equals(2);
    assume(entry.committedIndex).deep.equals(0);
  });

  it('#getEntriesAfter returns correct entries', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    const command3 = {'third': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    await log.put({
      index: 2,
      term: 1,
      command: command2
    });

    await log.put({
      index: 3,
      term: 1,
      command: command3
    });

    const entries = await log.getEntriesAfter(1);
    assume(entries.length).equals(2);
    assume(entries[0].index).equals(2);
    assume(entries[1].index).equals(3);
  });


  it('#removeEntriesAfter removes entries after entry', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    const command3 = {'third': 'command'};
    await log.put({
      index: 1,
      term: 1,
      command: command1
    });

    await log.put({
      index: 2,
      term: 1,
      command: command2
    });

    await log.put({
      index: 3,
      term: 1,
      command: command3
    });

    await log.removeEntriesAfter(1);
    const entry = await log.getLastEntry();
    assume(entry.index).equals(1);
  });

  it('#saveCommand saves commands', async () => {
    const command = {'first': 'command'};
    const term = 2;
    await log.saveCommand(command, term);

    const entry = await log.get(1);
    assume(entry.term).equals(2);
    assume(entry.committed).equals(false);
    assume(entry.command).deep.equals(command);
    assume(entry.responses.length).equals(1);
    assume(entry.responses[0]).deep.equals({address: 8000, ack: true});
  });

  it('#saveCommand saves all commands', async () => {
    const command1 = {'first': 'command'};
    const command2 = {'second': 'command'};
    const command3 = {'third': 'command'};

    await log.saveCommand(command1, 1);
    await log.saveCommand(command2, 1);
    await log.saveCommand(command3, 1);

    const entries = await log.getEntriesAfter(0);

    assume(entries.length).equals(3);
    assume(entries[0].command).deep.equals(command1);
    assume(entries[1].command).deep.equals(command2);
    assume(entries[2].command).deep.equals(command3);
  });
});
