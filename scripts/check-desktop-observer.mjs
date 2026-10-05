import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = ['main.cpp', 'observation.cpp', 'observation.h', 'protocol.h', 'observer.manifest', 'desktop-observer.vcxproj'];
export async function checkDesktopObserver() {
  const contents = new Map(await Promise.all(files.map(async name => [name, await readFile(path.join(root, 'native', 'desktop-observer', name), 'utf8')])));
  const cpp = ['main.cpp', 'observation.cpp', 'observation.h', 'protocol.h'].map(name => contents.get(name)).join('\n').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const prohibited = ['SendInput', 'SetForegroundWindow', 'SetFocus', 'SetWindowPos', 'PostMessage', 'SendMessage', 'PostThreadMessage', 'SendNotifyMessage', 'SendMessageCallback', 'SendMessageTimeout', 'mouse_event', 'keybd_event', 'SwitchToThisWindow', 'BringWindowToTop', 'SetActiveWindow', 'ShowWindow', 'ShowWindowAsync', 'CloseWindow', 'DestroyWindow', 'EndTask', 'MoveWindow', 'SetWindowPlacement', 'SetWindowText', 'AttachThreadInput', 'OpenClipboard', 'SetClipboardData', 'ShellExecute', 'ShellExecuteEx', 'CreateProcess', 'WinExec', 'SwitchDesktop', 'OpenProcessTokenForQueryAndSet', 'AdjustTokenPrivileges', 'CreateFile', 'DeleteFile', 'MoveFile', 'CopyFile', 'GetCurrentPattern', 'GetCurrentPatternAs', 'GetCachedPattern', 'GetCachedPatternAs', 'Invoke', 'SetValue', 'Select', 'AddToSelection', 'RemoveFromSelection', 'Toggle', 'Expand', 'Collapse', 'Scroll', 'SetScrollPercent', 'ScrollIntoView', 'Realize', 'FindAll', 'FindAllBuildCache', 'GetFocusedElement', 'GetWindowText', 'GetWindowTextLength', 'GetRuntimeId', 'system', '_wsystem', 'socket', 'connect', 'URLDownloadToFile'];
  const calls = [...new Set([...cpp.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map(match => match[1]))];
  const violations = prohibited.filter(name => calls.some(call => call === name || call === name + 'W' || call === name + 'A'));
  if (violations.length) throw new Error('Prohibited native call: ' + violations.join(', '));
  if (/IUIAutomation\w*Pattern\s*[*>&]|TreeScope_Descendants|IDispatch|LoadLibrary|GetProcAddress/.test(cpp)) throw new Error('Unreviewed native dispatch, callable pattern or descendant query.');
  const allowedProperties = new Set(['NativeWindowHandle', 'ProcessId', 'IsPassword', 'ControlType', 'IsEnabled', 'IsOffscreen', 'IsKeyboardFocusable', 'HasKeyboardFocus', 'ValueIsReadOnly', 'SelectionItemIsSelected', 'ToggleToggleState', 'ExpandCollapseExpandCollapseState', 'BoundingRectangle', 'IsInvokePatternAvailable', 'IsValuePatternAvailable', 'IsTextPatternAvailable', 'IsSelectionPatternAvailable', 'IsSelectionItemPatternAvailable', 'IsTogglePatternAvailable', 'IsExpandCollapsePatternAvailable', 'IsScrollPatternAvailable', 'Name', 'AutomationId', 'ClassName']);
  const properties = [...new Set([...cpp.matchAll(/UIA_(\w+)PropertyId/g)].map(match => match[1]))].sort();
  if (properties.some(name => !allowedProperties.has(name))) throw new Error('Unreviewed UIA property read.');
  const allowedComCalls = new Set(['GetCurrentPropertyValueEx', 'CheckNotSupported', 'put_AutoSetFocus', 'put_ConnectionTimeout', 'put_TransactionTimeout', 'get_RawViewWalker', 'GetRootElement', 'GetFirstChildElement', 'GetNextSiblingElement', 'ElementFromHandle']);
  const comCalls = [...new Set([...cpp.matchAll(/(?:uia_|uia|walker_|element_|child|frame\.element)->(\w+)\s*\(/g)].map(match => match[1]))].sort();
  if (comCalls.some(name => !allowedComCalls.has(name))) throw new Error('Unreviewed COM call.');
  const observation = contents.get('observation.cpp');
  if (!observation.includes('put_AutoSetFocus(FALSE)') || !observation.includes('GetCurrentPropertyValueEx(id, TRUE') || !observation.includes('if (protectionKnown && !protectedValue && functional(type))')) throw new Error('Protection-first property gate missing.');
  if (!contents.get('observer.manifest').includes('level="asInvoker" uiAccess="false"') || !contents.get('desktop-observer.vcxproj').includes('<RuntimeLibrary>MultiThreaded</RuntimeLibrary>')) throw new Error('Native privilege/runtime policy changed.');
  if (!contents.get('protocol.h').includes('Hello = 1, List = 2, Authorize = 3, Observe = 4')) throw new Error('Native protocol vocabulary changed.');
  return { scope: 'Production C++ source and closed direct UIA call/property vocabulary; not a formal proof about Windows/provider side effects.', prohibitedCallNamesChecked: prohibited.length, prohibitedCallsFound: violations, callablePatternInterfacesFound: 0,
    directComCalls: comCalls, propertyIds: properties, maximumPropertiesPerVisitedNode: 27, hardPropertyCeiling: 32,
    sourceIdentity: files.map(name => ({ file: 'native/desktop-observer/' + name, sha256: createHash('sha256').update(contents.get(name)).digest('hex') })) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await checkDesktopObserver();
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { shell: false, windowsHide: true, encoding: 'utf8' });
  if (found.status !== 0) throw new Error('Could not locate dumpbin for dependency evidence.');
  const version = (await readFile(path.join(found.stdout.trim(), 'VC', 'Auxiliary', 'Build', 'Microsoft.VCToolsVersion.default.txt'), 'utf8')).trim();
  const dumpbin = path.join(found.stdout.trim(), 'VC', 'Tools', 'MSVC', version, 'bin', 'Hostx64', 'x64', 'dumpbin.exe');
  const result = spawnSync(dumpbin, ['/nologo', '/dependents', path.join(root, 'dist-electron', 'desktop-observer', 'momo-desktop-observer.exe')], { shell: false, windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Native dependency inspection failed.');
  const dependencies = [...new Set(result.stdout.match(/[A-Za-z0-9_.-]+\.dll/gi) ?? [])];
  if (dependencies.some(name => /^(?:vcruntime|msvcp|ucrtbase)/i.test(name))) throw new Error('Unexpected dynamic C++ runtime dependency.');
  const directory = path.join(root, 'artifacts', 'desktop-observation-step2a'); await mkdir(directory, { recursive: true });
  const mt = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin', '10.0.19041.0', 'x64', 'mt.exe');
  const manifestFile = path.join(directory, 'embedded-manifest.xml');
  const manifestResult = spawnSync(mt, ['-nologo', `-inputresource:${path.join(root, 'dist-electron', 'desktop-observer', 'momo-desktop-observer.exe')};#1`, `-out:${manifestFile}`], { shell: false, windowsHide: true, encoding: 'utf8' });
  if (manifestResult.status !== 0) throw new Error('Embedded native manifest extraction failed.');
  const embedded = await readFile(manifestFile, 'utf8');
  if (!/level="asInvoker"/.test(embedded) || !/uiAccess="false"/.test(embedded)) throw new Error('Embedded native privilege manifest mismatch.');
  await writeFile(path.join(directory, 'native-audit.json'), JSON.stringify({ ...evidence, dependencies, embeddedManifest: { level: 'asInvoker', uiAccess: false }, binaryIdentity: JSON.parse(await readFile(path.join(root, 'dist-electron', 'desktop-observer', 'identity.json'), 'utf8')) }, null, 2) + '\n');
  console.log(JSON.stringify({ prohibitedCallNamesChecked: evidence.prohibitedCallNamesChecked, prohibitedCallsFound: 0, callablePatternInterfacesFound: 0, dependencies }));
}
