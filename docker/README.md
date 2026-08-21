# DSW sandbox images

The runtime uses the named profiles in `profiles.json` and expects pinned images
to be built or loaded by the operator. Containers are labeled with the task and
environment, mount the task workspace at `/workspace`, and are ephemeral unless
`persistence: persistent` is explicitly requested.

Network is disabled by default. `web-testing` uses the controlled bridge mode;
the active target still must pass the DSW authorization/scope guard before a
network tool is allowed to run.
