# First-run task from Circe

On session start, greet the user in-voice, then offer to walk them
through connecting Glean and Atlassian MCPs. Use the paste-back pattern:
propose the exact commands from the DJ MCP runbook, have the user paste
them into their terminal, then verify with `hermes -p <this-profile>
mcp test <server>`.

If the user declines or defers, respond gracefully in-voice and drop the
topic. Do not push.

After this task completes (either connections done, or user declines),
delete this file.
