<p align="center">
  <img src="docs/images/logo.svg" width="72" alt="EasyRead">
</p>
<h1 align="center">EasyRead</h1>
<p align="center"><b>Read English papers as comfortable, well-typeset Chinese.</b><br>
Drop in a PDF and it gets translated page by page in the background. Equations and tables keep their original layout, the source is always one click away, and you can highlight, take notes and ask AI as you read.<br>
Runs locally. Your papers and notes never leave your computer.</p>

<p align="center"><a href="README.md">简体中文</a> · <b>English</b></p>

<p align="center"><a href="https://edwardxlai.github.io/easyread/demo/"><b>▶ Try the live demo</b></a> · <a href="https://edwardxlai.github.io/easyread/en/">Homepage</a> · <a href="https://github.com/Edwardxlai/easyread/releases/latest">Download</a></p>

<p align="center">
  <a href="https://github.com/Edwardxlai/easyread/releases/latest"><img src="https://img.shields.io/github/v/release/Edwardxlai/easyread?label=release" alt="release"></a>
  <a href="https://github.com/Edwardxlai/easyread/actions/workflows/test.yml"><img src="https://github.com/Edwardxlai/easyread/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-runs%20locally-2f6070" alt="platforms">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT">
</p>

<p align="center"><img src="docs/images/pages.jpg" width="860" alt="Translation side by side with the original page"></p>

> **Who is this for?** EasyRead translates **English → Chinese**, and its interface is in Chinese. It's built for Chinese-speaking students and researchers. If you read Chinese (or want to help add other target languages), read on.

## How it differs from "throw the PDF into a translator"

- **Reads like a typeset book.** Serif body text, comfortable line length and spacing. Equations are re-rendered with KaTeX, tables become clean three-line tables, references stay in the original.
- **The original is always right there.** Toggle "bilingual" to show the English under each paragraph. Open the original page on the right: it follows your reading position and draws a box around the paragraph you're on.
- **Translation and commentary are kept apart.** The main text is only the faithful translation. AI explanations and answers go in the margin, so you always know what the paper actually says.
- **Ask AI while you read.** A chat panel with streaming answers. Quote several paragraphs at once (drag selected text into the input). Ask "how do the equations I highlighted in red relate?" and it finds your red highlights. Multiple chats, each with its own model: Claude, GPT (Codex), DeepSeek, Qwen, local Ollama… Pin a good answer to the margin in one click.
- **Annotate.** Four highlighter colors or underline, notes, questions. Send a question to AI with one click, or ask it to comment on a note. All annotations are collected in reading order and can be exported to Markdown (Obsidian, Notion).
- **Edit the translation.** Double-click a paragraph to edit it; change a term in the glossary and it's replaced everywhere.
- **Not just arXiv.** Drop in any PDF, or paste an arXiv ID, DOI, paper title or paper page (OpenReview, ACL, NeurIPS, bioRxiv, PMC, journal sites). It finds the open PDF and fills in authors, year and venue.
- **A library of your own.** Pin papers and folders, create folders and drag papers into them, recent reads, search, unread / reading / done, stars, reading progress, copy citation (GB/T 7714, APA, BibTeX), export a single-file offline HTML to share. Custom keyboard shortcuts.
- **Doesn't lose your work.** Every edit is saved in the browser first and only cleared once the local server confirms it's on disk. If a re-translation touches a paragraph you edited, you get a notice, not an overwrite.

<p align="center"><img src="docs/images/chat.jpg" width="860" alt="Ask AI while reading"></p>

<p align="center"><img src="docs/images/library.jpg" width="860" alt="Library"></p>

## Pick your translation model

| Engine | What you need | Notes |
|---|---|---|
| **Claude Code** (recommended) | [Claude Code](https://docs.claude.com/en/docs/claude-code/setup) installed and logged in | No API key, uses your subscription. Looks at the page image to check equations. Best quality |
| **Codex CLI** | [Codex](https://github.com/openai/codex) installed and logged in | No API key, uses your ChatGPT account |
| **API · China**: DeepSeek / Zhipu / Alibaba Bailian (Qwen) / Kimi / SiliconFlow / ModelScope | API key | Zhipu GLM-4.7-Flash and SiliconFlow small models are free; DeepSeek costs cents per paper |
| **API · International**: OpenAI / Anthropic / Gemini / OpenRouter / Groq / Cerebras | API key | Gemini, OpenRouter, Groq, Cerebras have free tiers |
| **API · Local**: Ollama / LM Studio | [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai) | Fully offline. qwen3.5:9b recommended (4b for small GPUs) |
| **API · Custom endpoint**: any OpenAI-compatible API or relay | URL + key | Both Chat Completions and Responses formats; "Fetch model list" pulls model names from the endpoint |

Settings auto-detect what's installed; "Test one sentence" tells you right away whether an engine works. A failed page (rate limit, network, quota) is retried automatically, then skipped so the rest keeps going, and you can retry all failed pages in one click at the end.

## Install

**Easiest: download the installer** (no Python needed). From [Releases](https://github.com/Edwardxlai/easyread/releases/latest):

- **Windows**: `EasyRead-Setup-x.x.x.exe`. It is not code-signed; if SmartScreen says "Windows protected your PC", click "More info → Run anyway".
- **macOS** (Apple silicon): `EasyRead-x.x.x-arm64.dmg`, drag EasyRead into Applications. The first launch says the developer cannot be verified: open System Settings → Privacy & Security and click "Open Anyway"; after that it opens normally.
- **Linux**: `EasyRead-x.x.x.AppImage`, `chmod +x` and run it.

Papers and settings live in the `EasyRead` folder in your home directory (same place as the pip install), so reinstalling keeps them.

**Or run from source** (needs Python 3.10+): download the latest zip from [Releases](https://github.com/Edwardxlai/easyread/releases/latest) and unzip it (or `git clone` this repo).

**Windows**: double-click `start.cmd`. The first run sets up the environment (about a minute); after that it opens right away.

**macOS / Linux**: in the unzipped folder, run

```bash
./start.sh
```

**Or with pip** (data goes to `~/EasyRead`):

```bash
pip install git+https://github.com/Edwardxlai/easyread
easyread
```

Your browser opens `http://127.0.0.1:8765`. The server only listens on localhost.

When launched with `start.cmd` / `start.sh`, the server exits about 8 seconds after the last library or reader tab closes. Refreshing, navigating, or closing only some tabs does not immediately stop it. Unfinished translations are paused; saved translations and notes are preserved. You can resume translation manually after restarting.

You can also choose “退出 EasyRead” (Exit EasyRead) in Settings or run `easyread stop` (`stop.cmd` on Windows). For a persistent background server, use `easyread serve --open`; add `--exit-on-close` to opt into automatic shutdown from the command line.

## Usage

1. Open Settings (top right) and pick a translation engine.
2. Drag a PDF into the window, or paste an arXiv ID, arXiv / OpenReview link or a direct PDF link (`Ctrl+V` on the library page works too). For long papers you can translate just the main text or the first few pages.
3. Translation runs in the background page by page. Translated parts are readable immediately; untranslated pages show the original.
4. Click a paragraph for its action bar; select text to highlight, note or ask. Press `?` for all shortcuts.

## Reading with an AI agent

EasyRead ships with a CLI, so agents like Claude Code or Codex can read your notes and questions in a conversation, write answers next to the right paragraphs, or translate / re-translate pages themselves. The skill is in [`skill/paper-reading/SKILL.md`](skill/paper-reading/SKILL.md); put that folder in `~/.claude/skills/` or `~/.codex/skills/`.

```bash
easyread list                          # list the library
easyread import paper.pdf              # or an arXiv ID / link
easyread status ID                     # progress, your edits, notes, open questions
easyread discuss ID --from answers.json   # write discussion into the margin
easyread export ID                     # export single-file offline HTML
```

See `easyread --help` for all commands and [docs/data-format.md](docs/data-format.md) for the data format.

## FAQ

**Does it cost anything?** EasyRead is free and open source. Translation uses your own model: Claude Code / Codex use your existing subscription, local and free-tier models cost nothing, paid APIs bill per use.

**Where is my data? Is anything uploaded?** Everything stays on your machine: `library/` in the project folder when run from source, `~/EasyRead/library/` after pip install. One folder per paper with the original PDF, page images and a few JSON files. Only the text being translated or asked about is sent to the model you chose.

**Can I read offline or share a paper?** Right-click a paper → "Export offline HTML" for a single-file web page with equations and page images included. To publish on a site such as GitHub Pages, use `easyread demo ID --out DIR`.

**Can it translate into languages other than Chinese?** Not yet. Prompts, typography and the UI are all tuned for Chinese. Issues and PRs are welcome.

## Development

No frontend build step: `easyread/web/` is plain HTML/CSS/JS, just refresh after editing. The backend uses the Python standard library plus PDF libraries.

```bash
python -m unittest discover tests         # unit tests
node tests/e2e.cjs library/<paper-id>     # browser end-to-end test (needs Playwright and a translated paper)
```

Design notes in [docs/design.md](docs/design.md), changes in [CHANGELOG.md](CHANGELOG.md) (both in Chinese).

## License

MIT. Math rendering by [KaTeX](https://katex.org) (MIT).

The demo paper is Rafailov et al., *Direct Preference Optimization: Your Language Model is Secretly a Reward Model* ([arXiv:2305.18290](https://arxiv.org/abs/2305.18290), CC BY 4.0). The Chinese translation was generated by EasyRead using Claude; highlights and notes in the demo are examples.
