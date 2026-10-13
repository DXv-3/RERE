import base64,json,subprocess,sys,tempfile,unittest
from pathlib import Path
class RecoveryExportTest(unittest.TestCase):
 def test_reads_hosted_text_without_executable_approvals_or_credentials(self):
  with tempfile.TemporaryDirectory(prefix='grok-recovery-test-') as tmp:
   source=Path(tmp)/'source';source.mkdir();output=Path(tmp)/'output'
   def blob(key,value):
    (source/(base64.b32encode(key.encode()).decode().strip('=').lower()+'.blob')).write_text(json.dumps({'value':value}))
   blob('roster.last-roster',{'rows':[{'id':'a','name':'Agent'}]})
   blob('transcript.replicas.a',{'entries':[{'kind':'message','id':'user','role':'user','content':'Old request','timestampMs':1},{'kind':'send-message','id':'assistant','message':{'type':'text','content':'Source result sk-'+('a'*32)},'timestampMs':2},{'kind':'send-message','id':'approval','message':{'type':'auto-review-approval','content':'Execute'},'timestampMs':3}]})
   subprocess.run([sys.executable,str(Path(__file__).with_name('export-grok-bot-recovery.py')),str(output),str(source)],check=True,capture_output=True)
   messages=json.loads((output/'grok-bot-recovery.json').read_text())['agents'][0]['history']['messages']
   self.assertEqual([m['role'] for m in messages],['user','assistant']);self.assertNotIn('sk-',messages[1]['text']);self.assertEqual(len(messages),2)
if __name__=='__main__':unittest.main()
