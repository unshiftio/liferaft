# liferaft

[![Build Status](https://travis-ci.org/unshiftio/liferaft.svg?branch=master)](https://travis-ci.org/unshiftio/liferaft)
[![Coverage Status](https://coveralls.io/repos/unshiftio/liferaft/badge.png?branch=master)](https://coveralls.io/r/unshiftio/liferaft?branch=master)

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

var LifeRaft = require('liferaft')
  , raft = new Raft();
```

Please note that the instructions for Node.js and browser are exactly the same
as we assume that your code will be compiled using a [Browserify] based system.
The only major difference is that you probably don't need to configure a commit
and append log (but this of course, fully optional).

The LifeRaft library is quite dumb by default. We try to be as lean and
extendible as possible so you, as a developer, have complete freedom on how you
want to implement Raft in your architecture. Things like transport layers and
replicated logs are all made optional so you can decided.

### Configuration

There are a couple of default options that you can configure in the constructor
of your Raft:

- `id` A unique id of the node that we just created. If none is supplied we will
  generate a random UUID.
- `heartbeat min` Minimum heartbeat timeout.
- `heartbeat max` Maximum heartbeat timeout.
- `election min` Minimum election timeout.
- `election max` Maximum election timeout.
- `Log`: An Log compatible constructor we which use for state and data
  replication. 

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

Event               | Description
--------------------|------------------------------------------------------
`term change`       | The term has changed.
`leader change`     | We're now following a newly elected leader.
`state change`      | Our state/role changed.
`heartbeat timeout` | Heartbeat timeout, we're going to change to candidate.
`data`              | Emitted by you, so we can work with the data.
`vote`              | We've received a vote request.
`leave`             | Node has been removed from the cluster.
`join`              | Node has been added to the cluster.
`end`               | This Raft instance has ended.
`initialize`        | The node has been fully initialized.

### LifeRaft.promote()

**Private method, use with caution**

This promotes the Node from `FOLLOWER` to `CANDIDATE` and starts requesting
votes from other connected nodes. When the majority has voted in favour of this
node, it will become `LEADER`.

```js
raft.promote();
```

### LifeRaft.join(name, write)

Add a new raft node to your cluster. The name is optional, but it would be nice
if it was the name of the node that you just added to the cluster.

```js
var node = raft.join('127.0.0.1:8080', function write(packet) {
  // Write the message to the actual server that you just added.
});
```

As seen in the example above it returns the `node` that we created. This `Node`
is also a Raft instance. When the node is added to the cluster it will emit the
`join` event. The event will also receive a reference to the node that was added
as argument:

```js
raft.on('join', function join(node) {
  console.log(node.name); // 127.0.0.1:8080
});
```

### LifeRaft.leave(name)

Now that you've added a new node to your raft cluster it's also good to know
that you remove them again. This method either accepts the name of the node that
you want to remove from the cluster or the returned `node` that was returned
from the [`LifeRaft.join`](#liferaftjoin) method.

```js
raft.leave('127.0.0.1:8080');
```

Once the node has been removed from the cluster it will emit the `leave` event.
The event will also receive a reference to the node that was removed as
argument:

```js
raft.on('leave', function leave(node) {
  console.log(node.name); // 127.0.0.1:8080
});
```

### LifeRaft.end()

This signals that the node wants to be removed from the cluster. Once it has
successfully removed it self, it will emit the `end` event.

```js
raft.on('end', function () {
  console.log('Node has shut down.');
});

raft.end();
```

## License

MIT

[Raft]: https://ramcloud.stanford.edu/raft.pdf
[Browserify]: http://browserify.org/
