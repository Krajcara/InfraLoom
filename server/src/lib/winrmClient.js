'use strict';

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const https = require('https');

const AGENT_INSECURE = new https.Agent({ rejectUnauthorized: false });

const WSA = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';
const WSMAN = 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd';
const RSP = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell';
const RES = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/cmd';

function soap(action, headerExtra, body, timeoutSec) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:wsa="${WSA}" xmlns:wsman="${WSMAN}" xmlns:rsp="${RSP}">
  <s:Header>
    <wsa:To>http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:To>
    <wsman:ResourceURI s:mustUnderstand="true">${RES}</wsman:ResourceURI>
    <wsa:ReplyTo><wsa:Address s:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2004/08/addressing/role/anonymous</wsa:Address></wsa:ReplyTo>
    <wsa:Action s:mustUnderstand="true">${action}</wsa:Action>
    <wsman:OperationTimeout>PT${timeoutSec}.000S</wsman:OperationTimeout>
    <wsa:MessageID>uuid:${uuidv4()}</wsa:MessageID>
    ${headerExtra}
  </s:Header>
  <s:Body>${body}</s:Body>
</s:Envelope>`;
}

function parseTag(xml, tag) {
  const m = xml.match(new RegExp(`<[^>]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>([^<]+)<`));
  return m ? m[1] : null;
}

function parseStreams(xml) {
  const decodeStream = (name) => {
    const pattern = new RegExp(`<rsp:Stream Name="${name}"[^>]*>([^<]*)</rsp:Stream>`, 'g');
    let result = '';
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      if (match[1]) result += Buffer.from(match[1], 'base64').toString('utf8');
    }
    return result;
  };
  const ecMatch = xml.match(/ExitCode>(\d+)/);
  return {
    stdout: decodeStream('stdout'),
    stderr: decodeStream('stderr'),
    exitCode: ecMatch ? parseInt(ecMatch[1], 10) : null,
    done: xml.includes('CommandState') && xml.includes('Done'),
  };
}

async function winrmPost(conn, body, timeoutMs = 30000) {
  const useHttps = !!conn.winrm_https;
  const port = conn.port || (useHttps ? 5986 : 5985);
  const host = conn.url.replace(/^https?:\/\//, '').split(':')[0].split('/')[0];
  const url = `${useHttps ? 'https' : 'http'}://${host}:${port}/wsman`;
  const auth = Buffer.from(`${conn.username}:${conn.password}`).toString('base64');

  const r = await axios.post(url, body, {
    headers: { 'Content-Type': 'application/soap+xml;charset=UTF-8', Authorization: `Basic ${auth}` },
    httpsAgent: AGENT_INSECURE,
    timeout: timeoutMs,
    validateStatus: (s) => s < 500,
  });

  if (r.status >= 400) throw new Error(`WinRM HTTP ${r.status}: ${r.data?.toString()?.slice(0, 200) || ''}`);
  return r.data;
}

/** Executes a PowerShell script on the remote host over WinRM and returns
 * { exitCode, stdout, stderr, durationMs }. Never throws — failures land in
 * stderr with exitCode -1, since a single bad script shouldn't crash a
 * caller that's enriching a whole VM list. */
async function executeScript(conn, script, timeoutSec = 60) {
  const start = Date.now();
  let shellId = null;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  try {
    const createResp = await winrmPost(
      conn,
      soap(
        'http://schemas.xmlsoap.org/ws/2004/09/transfer/Create', '',
        '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams><rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>',
        timeoutSec
      ),
      timeoutSec * 1000 + 5000
    );

    shellId = parseTag(createResp, 'ShellId');
    if (!shellId) throw new Error('Failed to open WinRM shell');

    const sel = `<wsman:SelectorSet><wsman:Selector Name="ShellId">${shellId}</wsman:Selector></wsman:SelectorSet>`;

    const cmdResp = await winrmPost(
      conn,
      soap(
        'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Command', sel,
        `<rsp:CommandLine><rsp:Command>powershell.exe</rsp:Command><rsp:Arguments>-NonInteractive -NoProfile -EncodedCommand ${encoded}</rsp:Arguments></rsp:CommandLine>`,
        timeoutSec
      ),
      timeoutSec * 1000 + 5000
    );

    const cmdId = parseTag(cmdResp, 'CommandId');
    if (!cmdId) throw new Error('Failed to get CommandId');

    let stdout = '';
    let stderr = '';
    let exitCode = null;
    const deadline = Date.now() + timeoutSec * 1000;

    while (exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const recvResp = await winrmPost(
        conn,
        soap(
          'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/Receive', sel,
          `<rsp:Receive><rsp:DesiredStream CommandId="${cmdId}">stdout stderr</rsp:DesiredStream></rsp:Receive>`,
          timeoutSec
        ),
        timeoutSec * 1000 + 5000
      );

      const s = parseStreams(recvResp);
      stdout += s.stdout;
      stderr += s.stderr;
      if (s.done) exitCode = s.exitCode ?? 0;
    }

    return { exitCode: exitCode ?? -1, stdout, stderr, durationMs: Date.now() - start };
  } catch (e) {
    return { exitCode: -1, stdout: '', stderr: e.message, durationMs: Date.now() - start };
  } finally {
    if (shellId) {
      try {
        await winrmPost(
          conn,
          soap(
            'http://schemas.xmlsoap.org/ws/2004/09/transfer/Delete',
            `<wsman:SelectorSet><wsman:Selector Name="ShellId">${shellId}</wsman:Selector></wsman:SelectorSet>`,
            '', 10
          ),
          10000
        );
      } catch {
        // best-effort cleanup — shell will eventually time out server-side anyway
      }
    }
  }
}

module.exports = { executeScript };
