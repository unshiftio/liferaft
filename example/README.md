# example

This is a small example on how to implement a transport layer for the `LifeRaft`
module. In this example we've implemented `axon` as default transport mechanism.
The only problem here is that axon will buffer messages if it cannot send it.
And in Raft, we will continue to attempt to send a message until we get
a successful callback. In order to fix this we've set the `hwm` (high water mark)
option of axon to `-1` to turn the queueing off.

## Starting the cluster

We assume 6 node cluster in this example this is so we can at least turn one
cluster off for fail over purposes. To start a node process on a different port
you can use the `--port` cli flag. To see how the internal work of all the
things you can enable the `DEBUG` environment variable and set it's value to
`*`.

So start the cluster we need to start the node process 6x times:

```
DEBUG=* node index.js --port 8081
DEBUG=* node index.js --port 8082
DEBUG=* node index.js --port 8083
DEBUG=* node index.js --port 8084
DEBUG=* node index.js --port 8085
DEBUG=* node index.js --port 8086
```

And behold. You have a cluster.
