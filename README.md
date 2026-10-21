# AI Guide – Personal AI Chat for Recruiters

An AI chat that answers recruiters' questions about my professional background: experience, education, projects and goals. It runs on my portfolio website and streams answers live from a local language model.

## Features

- **Live streaming answers** over WebSockets
- **Only approved facts:** everything the bot knows comes from [`server/bot/profile.json`](server/bot/profile.json)
- **English and German**, with formal "Sie" and Swiss spelling in German
- **Three layers of protection** against made-up answers and misuse:
  1. **Input guard:** role-play, prompt-injection and code requests get a fixed reply and never reach the model
  2. **System prompt:** strict rules plus example answers the model follows
  3. **Output check:** every answer is checked sentence by sentence before the visitor sees it (speculation, recommending other candidates and internal names are removed)
- **Reference contact** is added automatically to questions about my work experience

## How it works

```mermaid
flowchart LR
    V[Visitor<br/>client/index.html] -- WebSocket --> S[server.js]
    S --> G{Input guard}
    G -- role-play / injection / code request --> F[Fixed reply]
    G -- normal question --> P[System prompt<br/>+ profile.json<br/>+ chat history]
    P --> O[Ollama<br/>local LLM]
    O -- streamed tokens --> C[Sentence-by-sentence<br/>output check]
    C -- clean sentences --> V
    F --> V
```

- The **profile is re-read on every request**, so facts can be updated without restarting the server.
- The **chat history** sent by the browser is validated and capped (20 messages, length limit) before it reaches the model.
- **Low temperature (0.1)** and a larger context window (8,192 tokens) keep answers consistent and stop the rules from being cut off in long chats.
- If the model fails to add the reference contact, the server **appends it automatically** for questions about work experience.

## Tech stack

Node.js · WebSockets (`ws`) · Ollama (llama3.2) · HTML / CSS / JavaScript

## Project structure

```
server/
  server.js          WebSocket server (ws://localhost:8080/ws)
  bot/OllamaBot.js   Prompt, input guard, streaming and output check
  bot/profile.json   Approved facts about me
client/
  index.html         Standalone chat page
```

## Run it locally

Requirements: [Node.js](https://nodejs.org) and [Ollama](https://ollama.com) with the model installed (`ollama pull llama3.2`).

```bash
cd server
npm install
npm start
```

Then open `client/index.html` in the browser.

Another model can be used with the environment variable `OLLAMA_MODEL`, for example `OLLAMA_MODEL=qwen2.5:7b`.

> **Note:** The contact details in `profile.json` are placeholders in this public repository. On the live portfolio site they hold real, approved contacts.
