---
name: research
description: Use when you need current web information, research topics, or multiple sources. Executes parallel searches via Exa and Tavily APIs with automatic result deduplication and caching. Returns structured JSON. Requires jq and curl.
allowed-tools: Bash
---

# Research Skill

Autonomous web research for AI agents using Exa and Tavily APIs.

## Quick Start

```bash
./.pi/skills/research/scripts/research.sh "kubernetes best practices"
./.pi/skills/research/scripts/research.sh "query" [max_results] [mode]
```

## Configuration

Create `.env` in project root:

```bash
# Exa API Keys (2-4 for rotation)
EXA_API_KEY_1=your_key_here
EXA_API_KEY_2=
EXA_API_KEY_3=
EXA_API_KEY_4=

# Tavily API Keys (2-4 for rotation)
TAVILY_API_KEY_1=your_key_here
TAVILY_API_KEY_2=
TAVILY_API_KEY_3=
TAVILY_API_KEY_4=
```

Get keys:
- Exa: https://dashboard.exa.ai
- Tavily: https://app.tavily.com

## Usage for Agents

### Tool Call

```bash
./.pi/skills/research/scripts/research.sh "<search query>" [10] [fast]
```

### Parameters

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| query | required | - | Search query string |
| max_results | 10 | 5-20 | Number of results to return |
| mode | fast | fast\|synthesis | Output format (synthesis for LLM context) |

### Success Response

```json
{
  "success": true,
  "query": "kubernetes best practices",
  "results": [
    {
      "title": "Kubernetes Best Practices",
      "url": "https://kubernetes.io/docs/...",
      "content": "Full text content...",
      "score": 0.95,
      "sources": ["exa", "tavily"]
    }
  ],
  "meta": {
    "total": 15,
    "unique": 10,
    "cached": false,
    "elapsed_ms": 1250,
    "providers": ["exa", "tavily"]
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": "Both search providers failed",
  "details": {
    "exa": "API key not configured",
    "tavily": "Rate limit exceeded"
  }
}
```

## Features

- **Parallel Search**: Queries Exa and Tavily simultaneously
- **Auto Deduplication**: Merges results by URL, combines content
- **Smart Caching**: 5-minute TTL cache in `.pi/research-cache/`
- **Graceful Degradation**: Works with one provider if other fails
- **API Key Rotation**: Automatically tries 2-4 keys per provider
- **Auto .env Loading**: Reads API keys from project `.env` file

## When to Use

Use this skill when you need:
- Current information beyond knowledge cutoff
- Multiple sources on a topic
- Web pages, documentation, or articles
- Fact-checking or verification
- Research data for analysis

## Examples

### Example 1: Basic Research

```bash
./.pi/skills/research/scripts/research.sh "golang context best practices"
```

### Example 2: Limited Results

```bash
./.pi/skills/research/scripts/research.sh "docker compose tutorial" 5
```

## Error Handling

The script handles these scenarios:

| Scenario | Response |
|----------|----------|
| No API keys | `{"success":false,"error":"Both search providers failed",...}` |
| One provider fails | Returns results from working provider |
| Rate limit | Automatically tries next API key |
| Network error | Returns error with provider details |
| Cache hit | Returns cached result with `cached: true` |

## Supported Platforms

This skill works on:
- ✅ Windows (Git Bash or PowerShell)
- ✅ Ubuntu (Bash)

### Platform-Specific Notes

**Windows:**
- Git Bash: Uses Unix-style paths (`/c/Users/...`)
- PowerShell: Native Windows paths
- jq auto-detected in standard locations

**Ubuntu:**
- Standard bash
- jq and curl usually pre-installed or available via apt

## Dependencies

### Required
- `curl` — HTTP requests (pre-installed on Ubuntu, usually on Windows)
- `jq` — JSON processing (auto-detected on all platforms)

### Installing jq

**Windows (winget - recommended):**
```powershell
winget install jqlang.jq
```

**Windows (manual):**
1. Download from https://jqlang.github.io/jq/download/
2. Add to PATH or place in `C:\Windows\System32`

**Ubuntu:**
```bash
sudo apt-get update && sudo apt-get install -y jq curl
```

## Cache

- Location: `.pi/research-cache/`
- TTL: 5 minutes
- Key: SHA256 of `query:max_results`
- Format: JSON files

## Tips for Agents

1. **Always check `success` field** before processing results
2. **Use `meta.unique`** to know actual result count after deduplication
3. **Check `meta.cached`** to know if result came from cache
4. **Handle errors gracefully** — one provider may fail
5. **Respect rate limits** — results are cached for 5 minutes
6. **Use specific queries** — include dates, versions, or specific terms for better results

## Workflow

```
Agent needs web info
    ↓
Calls research.sh with query
    ↓
Script loads .env, checks cache
    ↓
Parallel search (Exa + Tavily)
    ↓
Normalize → Deduplicate → Rank
    ↓
Return JSON with results
    ↓
Agent processes structured data
```
