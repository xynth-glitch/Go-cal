# Teacher Mode TTS API Contract

Endpoint: `POST /api/teacher-mode/tts`

## Request

```json
{
  "provider": "sarvam",
  "modelPriority": ["bulbul:v3", "bulbul:v2"],
  "chunks": [
    {
      "text": "Ab expression pe dhyan do",
      "target": "(a+b)^2",
      "startTime": 0,
      "stepId": 0
    }
  ]
}
```

## Response

```json
{
  "audioUrl": "https://cdn.example.com/teacher-mode/session-123.mp3",
  "provider": "sarvam",
  "modelUsed": "bulbul:v3",
  "cacheHits": {
    "connector": 2,
    "concept": 1
  }
}
```

## Notes
- Generate voice only after explicit microphone click.
- Reuse cached connector narrations.
- Reuse cached popular concept script+audio where available.
- Dynamically synthesize only unique chunks.
