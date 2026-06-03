import json

# Remove cpamc from agent models.json
path = '/root/.openclaw/agents/main/agent/models.json'
with open(path) as f:
    d = json.load(f)

if 'cpamc' in d.get('providers', {}):
    del d['providers']['cpamc']
    print('Removed cpamc provider from agent models.json')
else:
    print('No cpamc provider in agent models.json')

with open(path, 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
print('Providers:', list(d.get('providers', {}).keys()))
