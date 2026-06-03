import json

with open("/root/.openclaw/openclaw.json") as f:
    config = json.load(f)

# --- Add cpamc provider ---
cpamc_models = [
    {"id": "deepseek-v4-pro",       "name": "DeepSeek V4 Pro",          "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "deepseek-v4-flash",     "name": "DeepSeek V4 Flash",        "reasoning": False, "input": ["text"], "contextWindow": 128000, "maxTokens": 16000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "gpt-5.5",               "name": "GPT 5.5",                   "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "gpt-5.4",               "name": "GPT 5.4",                   "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 16000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "gpt-5.4-mini",          "name": "GPT 5.4 Mini",              "reasoning": False, "input": ["text"], "contextWindow": 200000, "maxTokens": 16000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "mimo-v2.5-pro",         "name": "MiMo V2.5 Pro",             "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "mimo-v2.5",             "name": "MiMo V2.5",                  "reasoning": False, "input": ["text"], "contextWindow": 128000, "maxTokens": 16000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "minimax-m2.7",          "name": "MiniMax M2.7",              "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "minimax-m2.5",          "name": "MiniMax M2.5",              "reasoning": False, "input": ["text"], "contextWindow": 128000, "maxTokens": 16000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "glm-5.1",               "name": "GLM 5.1",                   "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "kimi-k2.6",             "name": "Kimi K2.6",                 "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "gemini-3.1-pro-high",   "name": "Gemini 3.1 Pro High",       "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "gemini-3.1-flash-lite", "name": "Gemini 3.1 Flash Lite",     "reasoning": False, "input": ["text"], "contextWindow": 128000, "maxTokens": 8192,  "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
    {"id": "claude-sonnet-4-6",     "name": "Claude Sonnet 4.6",         "reasoning": True,  "input": ["text"], "contextWindow": 200000, "maxTokens": 32000, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}},
]

config["models"]["providers"]["cpamc"] = {
    "baseUrl": "http://localhost:8317/v1",
    "apiKey": "6pG0B1YScDVGjoqln6Jlf_Kd7jmvv_oAVuPTGT4opyu0Re5Zc4qVDElTrLlB9bPr",
    "api": "openai-completions",
    "models": cpamc_models
}

# --- Update agents.defaults ---
agents = config["agents"]["defaults"]

# New primary + fallbacks
agents["model"]["primary"] = "cpamc/deepseek-v4-pro"
agents["model"]["fallbacks"] = [
    "cpamc/gpt-5.5",
    "openai-codex/gpt-5.4",
    "qwen-portal/coder-model"
]

# Register CPAMC models in agents.defaults.models
cpamc_model_entries = {}
for m in cpamc_models:
    key = "cpamc/" + m["id"]
    alias = m["id"]
    cpamc_model_entries[key] = {"alias": alias}

agents["models"].update(cpamc_model_entries)

# --- Write back ---
with open("/root/.openclaw/openclaw.json", "w") as f:
    json.dump(config, f, indent=2, ensure_ascii=False)

print("Config updated successfully")
print("Providers:", list(config["models"]["providers"].keys()))
print("Primary model:", agents["model"]["primary"])
print("Fallbacks:", agents["model"]["fallbacks"])
print("CPAMC models registered:", len(cpamc_models))
