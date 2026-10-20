# Standup transcription bot

Sends a self-hosted [Vexa](https://github.com/Vexa-ai/vexa) bot into the team's
recurring Google Meet standup, waits for a host to admit it, and stores
speaker-attributed, timestamped transcript segments in its own Postgres. It is
a standalone Node service: it does not run inside the T3 server, and it sends
no messages and triggers no agents.

Vexa v0.12.28 was chosen (Apache-2.0) so meeting audio and transcripts stay on
infrastructure we run. The service schedules joins itself instead of using
Vexa's calendar auto-join: Vexa's recurring support depends on a secret ICS
feed, and sending `POST /bots` per occurrence fixes the bot name, recording
setting, and admission timeout on every request.

## Run

Requires Docker and Node 24.

```sh
# 1. Vexa Lite + CPU Whisper (behind a token-checking proxy) + the standup
#    Postgres, published on loopback only. All four values are random secrets
#    the operator generates.
VEXA_ADMIN_TOKEN=... VEXA_INTERNAL_API_SECRET=... VEXA_STT_TOKEN=... \
  STANDUP_POSTGRES_PASSWORD=... docker compose -f apps/standup-bot/docker-compose.yml up -d

# 2. A Vexa API key with `bot,tx` scopes. Vexa Lite mints one for its
#    self-host user on first boot (/run/vexa/key.env inside the container), or
#    mint one through Vexa's admin API (POST /admin/users/{id}/tokens?scopes=bot,tx
#    with X-Admin-API-Key). Then:
export STANDUP_DATABASE_URL=postgres://standup:$STANDUP_POSTGRES_PASSWORD@127.0.0.1:5442/standup
export VEXA_API_KEY=<key>
pnpm --filter @t3tools/standup-bot start migrate
pnpm --filter @t3tools/standup-bot start series add --name "Engineering standup" \
  --meeting-url https://meet.google.com/abc-defg-hij \
  --weekdays mon,tue,wed,thu,fri --time 09:30 --time-zone America/Los_Angeles
pnpm --filter @t3tools/standup-bot start run
```

`VEXA_API_URL` defaults to `http://localhost:8056`. Set `POSTHOG_API_KEY` to
report absorbed failures and failed outcomes; reports carry ids and reasons,
never transcript text or speaker names. Other commands (`occurrences`,
`transcript <id>`, `stop <id>`) are listed at the top of
[src/cli.ts](src/cli.ts). `stop` makes the bot leave and ends transcription for
that occurrence, whether or not `run` is active.

Later phases read `standup_transcript_segments` joined to `standup_occurrences`
and `standup_series`; the schema is in [src/store.ts](src/store.ts).

## Activation

Each step needs Vivek's approval before the bot joins a real standup:

1. A host to run the stack, and where its secrets live.
2. An isolated test meeting that passes: lobby admission, live transcript with
   speakers and timestamps, WebSocket reconnect and backfill, operator stop with
   confirmed departure, final reconciliation, and no `signal/` objects in Vexa
   storage afterwards.
3. The standup Meet link and schedule, and the consent notice below in the
   standup invite.

## Consent and admission

- The display name is the constant `Standup Transcription Bot`, so every
  participant sees that a transcription bot is present.
- Before a series is enabled, its organizer adds a notice to the standup invite
  stating that the call is transcribed by that bot, what is stored, and who can
  stop it. Treat transcription as requiring all-party notice; do not enable a
  series that includes external participants without telling them.
- A host admits the bot each time; it never tries to bypass the lobby. Vexa
  gives up after 10 minutes, and the service asks the bot to leave at 12 minutes
  if Vexa has not reported a verdict, recording the occurrence as `not_admitted`.
- Audio recording is off on every request. Vexa separately tapes each bot's raw
  audio frames (`captured-signal.v1`) unless the platform diagnostics setting
  `capture_signal` is `"false"`; the compose `post_start` hook writes it on every
  start. Vexa treats an unreadable setting as on, so check storage for `signal/`
  objects after a test meeting.

## What Vexa v0.12.28 provides

Verified against commit
[`f1a62fbb`](https://github.com/Vexa-ai/vexa/tree/f1a62fbbdfd2c98cb162582d82c31fe8102acc89).

- **Join:** `POST /bots` with `platform: google_meet` and the Meet code. The bot
  joins as a guest (no Google account) and waits in the lobby under the
  request's `bot_name`.
- **Admission:** `requested → joining → awaiting_admission → active`;
  `needs_help` means it is stuck before admission. Not admitted within
  `automatic_leave.max_wait_for_admission` ends with `completion_reason`
  `awaiting_admission_timeout`, or `awaiting_admission_rejected` when denied.
- **Stop:** `DELETE /bots/google_meet/{code}` (404 when no bot is running); the
  run ends with `completion_reason: stopped`.
- **Live transcript:** the gateway `/ws` multiplex forwards transcript bundles
  (`confirmed` and `pending` segments) and `meeting.status` frames. Vexa's
  README still lists WebSocket multiplexing as planned, but the gateway serves
  it. `GET /transcripts/by-id/{id}` returns the stored transcript.
- **Segments:** `segment_id`, `text`, `start`/`end` (seconds from bot session
  start), `absolute_start_time`/`absolute_end_time`, `language`, `speaker`,
  `speaker_key`, `confidence`, and word timings. Vexa publishes an empty speaker
  for roughly 4–7% of rows under crosstalk and records no roster of silent
  participants.
- **In-meeting notice:** none. Bot chat send and text-to-speech are not
  implemented in the open-core stack, so the display name is the only in-call
  disclosure.
- **Transcription:** one OpenAI-compatible endpoint,
  `{TRANSCRIPTION_SERVICE_URL}/v1/audio/transcriptions` with a bearer token:
  Vexa's faster-whisper service, the faster-whisper-server image used here,
  Vexa's hosted service, or OpenAI, Groq, vLLM/LiteLLM, FunASR. Vexa only probes
  and trusts an endpoint configured with both a URL and a token, which is why
  the compose file puts a token-checking proxy in front of Whisper. Its probe
  also counts any non-auth status (including 502 while Whisper loads) as healthy.
- **Azure:** Azure AI Speech has no Vexa provider. Azure OpenAI's v1 endpoint
  (`https://<resource>.openai.azure.com/openai/v1/…`) has the same path shape and
  may work with the deployment name as `TRANSCRIPTION_MODEL`, but bearer-key
  authentication and `verbose_json` support are untested.
