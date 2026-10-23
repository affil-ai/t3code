# Giving agents secrets

When an agent needs a token, API key, or password, it asks with a private card in the thread
instead of asking in chat. Paste the value into the card and choose **Save securely**. The agent
never sees it, and it never appears in the conversation. A card can ask for several values at
once, such as a username and a password.

The agent can then use the value without seeing it: call an API, store it in a secret manager,
sign a CLI in, or write it to a private file. T3 Code runs the agent's command on the machine
running T3 Code, hands the value to it, and replaces the value with `[REDACTED]` in the output
the agent sees, including common encodings such as base64 and URL encoding.

Things to know:

- A saved value works only in the thread that asked for it, for 15 minutes. After that the
  agent has to ask again. Other threads and subagents cannot use it.
- Running commands with a secret needs the thread's [permission mode](./permission-modes.md) to
  be **Full access**, because those commands run without approval prompts.
- Redaction guards against accidents. An agent that deliberately transforms a value before
  printing it can still reveal it, so only give secrets to agents you would trust with a
  terminal on that machine.
