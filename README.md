# Docker Kicker #

A stupid-simple web app to receive web requests and in response kick off a container instance.

_In its current state, it is not advisable to use this in a production setting. And DEFINITELY don't expose this to the Internet._

## Config ##

Set the following environment variables:

```
KICKER_DOCKERCONNECTCONFIG="connect config JSON, see below"
KICKER_PORT=41331
KICKER_CONFIG="config JSON, see below"
```

### Connect Config JSON ###

Should parse to any valid connect configuration for (Docker Modem)[https://github.com/apocas/docker-modem]

```json5
{
    "socketPath":"",
    "protocol":"",
    "host":"",
    "port":1,
}
```

### Config JSON ###

Describes what container to launch and what web URL will launch it.

In the below example, POSTing to `http(s)://docker-kicker.your.org/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` would try to launch an instance of `docker/image:tag`.

```json5
{
    // Unique name for the configuration
    "name": "config name",
    // The key to pass to the web app to launch the below container instance
    "key": "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    // IP restrictions
    "allowFrom": ["IPv6", "IPv4", ...],
    // Docker image + tag
    "image": "docker/image:tag",
    // Startup command
    "cmd": ["command", ...],
    // Docker API Container Create options
    "createOptions": {
        // See: https://docs.docker.com/engine/api/v1.37/#operation/ContainerCreate
        "Env": [
            "FOO=abc",
            "BAR=123",
            ...
        ],
        ...
    },
    // Maximum number of instances launched from this config allowed to run simultaneously
    "limit": 2
}
```