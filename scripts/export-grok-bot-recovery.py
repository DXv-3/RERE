"""Read only Grok Bot's profile/transcript cache; never credentials or live task state.
Usage: python scripts/export-grok-bot-recovery.py /private/output/directory
"""
import base64
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

source = Path(sys.argv[2]) if len(sys.argv)>2 else Path.home() / 'Library/Application Support/Grok Bot/sand-client-persistence'
output = Path(sys.argv[1]); output.mkdir(parents=True, exist_ok=True)
roster, transcripts, pinned = {}, {}, set()
for path in source.glob('*.blob'):
    try:
        key = base64.b32decode(path.stem.upper() + '=' * ((-len(path.stem)) % 8)).decode()
        if not any(part in key for part in ('roster.last-roster', 'transcript.replicas.', 'ui-agent-refs')):
            continue
        value = json.loads(path.read_bytes())['value']
        if 'roster.last-roster' in key:
            for row in value.get('rows', []):
                if isinstance(row.get('id'), str): roster[row['id']] = row
        elif 'ui-agent-refs' in key:
            pinned.update(value.get('pinnedAgentIds', []))
        else:
            transcripts[key.rsplit('.', 1)[-1]] = (value, path.name)
    except (ValueError, KeyError, UnicodeError):
        continue
now = datetime.now(timezone.utc).isoformat()
agents, audit = [], []
for sid, row in roster.items():
    cache, filename = transcripts.get(sid, ({}, None))
    messages = {}
    for entry in cache.get('entries', []):
        # Hosted assistant text is often stored as a send-message envelope.
        # Widgets, approvals, connectors, secrets, and routines are evidence only.
        if entry.get('kind') == 'send-message' and entry.get('message',{}).get('type') == 'text':
            role, content = 'assistant', entry['message'].get('content')
        elif entry.get('kind') == 'message' and entry.get('role') in ('user', 'assistant'):
            role, content = entry['role'], entry.get('content')
        else: continue
        if not isinstance(content,str) or not content.strip(): continue
        content = re.sub(r'\b(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b', '[Credential redacted; reconnect through server secret storage]', content)
        mid = str(entry.get('id', ''))
        if mid: messages[mid] = {'id': mid, 'role': role, 'text': content, 'timestampMs': entry.get('timestampMs')}
    ordered = sorted(messages.values(), key=lambda m:m['timestampMs'] or 0)
    name = row.get('name') or row.get('title') or 'Imported Agent'
    latest_user = next((m for m in reversed(ordered) if m['role'] == 'user'), None)
    latest_assistant = next((m for m in reversed(ordered) if m['role'] == 'assistant'), None)
    entries = cache.get('entries', [])
    audit.append({'sourceId':sid,'name':name,'observedAt':now,'sourceFile':filename,'sourceCachePersistedAt':cache.get('persistedAt'),
      'lastActivityAt':row.get('lastActivityAt'),'awaitingUserResponse':row.get('awaitingUserResponse'),
      'latestCachedRequest':latest_user,'latestCachedReportedResult':latest_assistant,
      'verifiedResult':None,'runningTaskStatus':'unknown','routineStatus':'unknown','connectionStatus':'unknown','computerSessionStatus':'unknown',
      'attachmentEntries':sum(e.get('kind')=='user-attachment' or e.get('message',{}).get('type')=='attachment' for e in entries),
      'hostedEvidenceKinds':sorted(set(e.get('message',{}).get('type') for e in entries if e.get('kind')=='send-message' and e.get('message',{}).get('type')!='text')),
      'disposition':'blocked','blockers':['Verify the latest hosted conversation and active task state.','Recover referenced files, connections, routines, and computer access.'],
      'messageCount':len(ordered),'notes':'Bot reports are historical evidence, not independent verification. Nothing has been resumed.'})
    agents.append({'sourceId':sid,'name':name,'description':row.get('description') or '',
      'avatarColor':row.get('avatarColor') or '', 'avatarShape':row.get('avatarShape') or '', 'pinned':sid in pinned,
      'sourceSettings':{k:row.get(k) for k in ('notificationsEnabled','notifyOnUpdatesEnabled','isHiddenFromSidebar','voiceId','voiceSpeed','voiceLanguage','isGroup')},
      'history':{'coverage':'local-cache-only','cachedAt':cache.get('persistedAt'),'messages':ordered}})
def private_write(path, body):
    descriptor=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)
    with os.fdopen(descriptor,'w') as stream:stream.write(body)
private_write(output/'grok-bot-recovery.json', json.dumps({'format':'workbench-grok-bot-import','version':1,'exportedAt':now,'agents':agents},indent=2))
private_write(output/'team-audit.json',json.dumps({'observedAt':now,'coverage':'read-only-cache','agents':audit},indent=2))
lines=['# Agent Recovery Checklist','',f'Observed: {now}. Cached evidence only; hosted execution state remains unverified.','', '| Agent | Cached Messages | Disposition | Next Verification |','|---|---:|---|---|']
for row in audit:lines.append(f"| {row['name']} | {row['messageCount']} | Blocked | Latest source state, dependencies, and ongoing work |")
private_write(output/'TEAM_RECOVERY.md','\n'.join(lines)+'\n')
print(json.dumps({'agents':len(agents),'messages':sum(len(a['history']['messages']) for a in agents),'output':str(output)}))
