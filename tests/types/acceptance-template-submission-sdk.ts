/** Real public SessionBinding prompt and submission handle; no ClientRemote declaration replacement. */
import type {} from '@deepseek-ai/dsh-api-session-controller/remote';
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client';
import { TemplateRerunSubmission } from '../../src/features/acceptance-templates/rerun-submission.ts';
declare const binding: SessionBinding;
const request=new TemplateRerunSubmission({currentChat:()=>binding.sessionId,binding:()=>binding,signal:new AbortController().signal});
const prompt:SessionBinding['session']['prompt']=binding.session.prompt;
void[request,prompt];
