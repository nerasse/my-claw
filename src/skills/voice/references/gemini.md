# Gemini TTS

Active when `voice.tts.provider` is `"gemini"` (cloud mode, `GEMINI_API_KEY` in `.env`). It
replaces Edge entirely: no Edge voice name works there, and no failure falls back to Edge.

## Voices (French, curated)

Pick by what the user asks ("a woman's voice", "a deep older voice", "something energetic").
The default is the configured `voice.tts.voice`.

| Id | Gender | Age | Character |
|---|---|---|---|
| `fr-fr-podcaster-2` | male | 34 | radio host, resonant and witty (default) |
| `fr-fr-podcaster-4` | male | 51 | radio host, laid-back, encouraging |
| `fr-fr-podcaster-12` | male | 55 | podcast interviewer, natural and clear, low |
| `fr-fr-podcaster-8` | male | 28 | podcast interviewer, young |
| `fr-fr-concierge-7` | male | 37 | cool, confident |
| `fr-fr-podcaster-9` | female | 28 | radio host, natural and clear |
| `fr-fr-podcaster-1` | female | 41 | radio host, clear, low |
| `fr-fr-podcaster-11` | female | 50 | interviewer, objective and direct |
| `fr-fr-podcaster-3` | female | 34 | interviewer, bright, high |
| `fr-fr-assistant-8` | female | 45 | podcast host, warm |
| `fr-fr-assistant-6` | female | 31 | storyteller, energetic, fast |
| `fr-fr-assistant-9` | neutral | 45 | narrator, intimate talk-show |

81 French voices exist. For others (or another language), the full list with gender, age and
persona is `GET https://generativelanguage.googleapis.com/v1beta/voices?language_code=fr-FR&page_size=200`
with the header `x-goog-api-key: $GEMINI_API_KEY`.

## Calls

```tool
audio(action="speak", text="...", voice="fr-fr-podcaster-9", style="voix posée de journaliste radio")
audio(action="speak",
      text="Léa: Bon, on attaque les chiffres.\nMarc: Vas-y.\nInès: Attendez, j'ai une question.",
      speakers=[{"name": "Léa", "voice": "fr-fr-podcaster-9"},
                {"name": "Marc", "voice": "fr-fr-podcaster-2", "style": "amusé"},
                {"name": "Inès", "voice": "fr-fr-assistant-6"}])
```

- **Speakers**: 1 to 4, names unique and without `:`. Every line of text starts with `Name:`;
  a line without a known name continues the previous turn.
- **Style**: `style` for the whole reading, or per speaker (it wins for that speaker). Never read
  aloud.
- **Inline tags** are performed, not read: `<short pause>`, `<sigh>`, `<laugh>`. Any other stage
  direction written in the text **is** read aloud.

## Writing a podcast

- Write it as people talk: short turns, reactions ("bon", "attends", "ah oui ?"), questions,
  interruptions. Not a report cut into parts.
- Numbers as they should be heard when it matters ("trente-deux pour cent").
- Give each voice a role (host, guest, sceptic) and keep it.

## Quota (free tier)

**10 requests per model per day.** One request voices at most 2 speakers and ~4000 characters,
so the cost is one request per ~4000 characters **or per change of speaker pair**: `A B A C A B`
costs 3 requests. Group the exchanges of a pair together when there are 3 or 4 voices.

A text needing more than 10 is refused before any request: shorten it or regroup the turns. A
daily-quota error says when it resets: report it, do not retry. Ceiling: 40 000 characters.
