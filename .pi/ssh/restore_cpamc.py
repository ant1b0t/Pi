import json
with open('/root/.openclaw/openclaw.json') as f:
    c = json.load(f)

c['models']['providers']['cpamc'] = {
    'baseUrl': 'http://localhost:8317/v1',
    'apiKey': '6pG0B1YScDVGjoqln6Jlf_Kd7jmvv_oAVuPTGT4opyu0Re5Zc4qVDElTrLlB9bPr',
    'api': 'openai-completions',
    'models': [
        {"id":"deepseek-v4-pro","name":"DeepSeek V4 Pro","reasoning":False,"input":["text"],"contextWindow":200000,"maxTokens":32000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}},
        {"id":"gpt-5.4-mini","name":"GPT 5.4 Mini","reasoning":False,"input":["text"],"contextWindow":200000,"maxTokens":16000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}},
        {"id":"kimi-k2.6","name":"Kimi K2.6","reasoning":False,"input":["text"],"contextWindow":200000,"maxTokens":32000,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}},
    ]
}
c['agents']['defaults']['model']['primary'] = 'cpamc/deepseek-v4-pro'
c['agents']['defaults']['model']['fallbacks'] = ['cpamc/gpt-5.4-mini', 'openai-codex/gpt-5.4']
for m in c['models']['providers']['cpamc']['models']:
    key = 'cpamc/' + m['id']
    c['agents']['defaults']['models'][key] = {'alias': m['id']}
with open('/root/.openclaw/openclaw.json', 'w') as f:
    json.dump(c, f, indent=2, ensure_ascii=False)
print('OK:', c['agents']['defaults']['model']['primary'])
