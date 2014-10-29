# liferaft

`liferaft` is an JavaScript implementation of the [Raft] consensus algorithm. 

## Installation

The `liferaft` module is distributed through npm and is compatible with
`browserify` as well as `node.js`. You can install this module using:

```
npm install --save liferaft
```

## Usage

In all examples we assume that you've imported the `liferaft` module as
following:

```js
'use strict';

var LifeRaft = require('liferaft');
```

### Configuration

There are a couple of default options that you can configure in the constructor
of your Raft:

- `id` A unique id of the node that we just created. If none is supplied we will
  generate a random UUID.
- `heartbeat min` Minimum heartbeat timeout.
- `heartbeat max` Maximum heartbeat timeout.
- `election min` Minimum election timeout.
- `election max` Maximum election timeout.

The timeout values can be configured with either a number which represents the
time milliseconds or a human readable time string such as `10 ms`. The election
timeout is the leading timeout if you don't provide default values for the
heartbeat it will default to the values of the election timeout. The heartbeat
timeouts are used to detect a disconnection from the `LEADER` process if no
message has been received within the given timeout we assume its dead that we
should be promoted to master. The election timeout is the time it may take to
reach a consensus about the master election process. If this times out, we will
start another re-election.

### Events

The `liferaft` module is an `EventEmitter` at it's core and is quite chatty
about the events it emits.

`term change`       | The term has changed.
`leader change`     | We're now following a newly elected leader.
`state change`      | Our state/role changed.
`heartbeat timeout` | Heartbeat timeout, we're going to change to candidate.
`data`              | Emitted by you, so we can work with the data.
`vote`              | We've received a vote request.

## License

MIT

[Raft]: https://ramcloud.stanford.edu/wiki/download/attachments/11370504/raft.pdf
