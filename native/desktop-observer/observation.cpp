#include "observation.h"
#include <Dwmapi.h>
#include <cwctype>
#include <set>

namespace observer {
namespace {
struct Handle { HANDLE value; explicit Handle(HANDLE h = nullptr) : value(h) {} ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); } };
std::wstring lower(std::wstring value) { for (auto& c : value) c = static_cast<wchar_t>(towlower(c)); return value; }
bool sameTime(const FILETIME& a, const FILETIME& b) { return a.dwLowDateTime == b.dwLowDateTime && a.dwHighDateTime == b.dwHighDateTime; }
std::string uuid() {
  GUID value{}; if (FAILED(CoCreateGuid(&value))) return {};
  wchar_t wide[40]{}; if (StringFromGUID2(value, wide, 40) != 39) return {};
  std::string out; for (int i = 1; i <= 36; ++i) out += static_cast<char>(towlower(wide[i])); return out;
}
std::string containsFocus(HWND window) {
  GUITHREADINFO info{ sizeof(GUITHREADINFO) };
  const DWORD thread = GetWindowThreadProcessId(window, nullptr);
  if (!thread || !GetGUIThreadInfo(thread, &info)) return absent("unavailable");
  return boolean(info.hwndFocus && (info.hwndFocus == window || IsChild(window, info.hwndFocus)));
}
const char* role(LONG value) {
  static const char* roles[] = { "button", "calendar", "checkbox", "combobox", "edit", "hyperlink", "image", "listitem", "list", "menu", "menubar", "menuitem", "progressbar", "radio", "scrollbar", "slider", "spinner", "statusbar", "tab", "tabitem", "text", "toolbar", "tooltip", "tree", "treeitem", "custom", "group", "thumb", "datagrid", "dataitem", "document", "splitbutton", "window", "pane", "header", "headeritem", "table", "titlebar", "separator", "semanticzoom", "appbar" };
  static_assert(sizeof(roles) / sizeof(roles[0]) == UIA_AppBarControlTypeId - UIA_ButtonControlTypeId + 1, "Complete control type mapping");
  return value >= UIA_ButtonControlTypeId && value <= UIA_AppBarControlTypeId ? roles[value - UIA_ButtonControlTypeId] : "unknown";
}
bool functional(const std::string& r) { return r == "button" || r == "checkbox" || r == "menuitem" || r == "radio" || r == "tabitem" || r == "slider" || r == "spinner" || r == "splitbutton" || r == "scrollbar"; }
bool contentBoundary(const std::string& r) { return r == "edit" || r == "document" || r == "text" || r == "listitem" || r == "datagrid" || r == "dataitem" || r == "tooltip" || r == "image" || r == "custom" || r == "unknown"; }
// Property values only. No callable UIA pattern interface is ever acquired.
class Properties final {
  IUIAutomation2* uia_; IUIAutomationElement* element_; Outcome& outcome_; unsigned count_ = 0;
public:
  Properties(IUIAutomation2* uia, IUIAutomationElement* element, Outcome& outcome) : uia_(uia), element_(element), outcome_(outcome) {}
  struct Value {
    VARIANT data{}; const char* state = "unknown";
    Value() { VariantInit(&data); }
    ~Value() { VariantClear(&data); }
    Value(const Value&) = delete; Value& operator=(const Value&) = delete;
  };
  void read(PROPERTYID id, Value& value) {
    if (++count_ > MaxProperties) { outcome_.limit("PROPERTIES"); value.state = "unavailable"; return; }
    if (GetTickCount64() - outcome_.started >= TreeMs) { outcome_.limit("TIME"); value.state = "unavailable"; return; }
    if (FAILED(element_->GetCurrentPropertyValueEx(id, TRUE, &value.data))) { value.state = "unavailable"; outcome_.reason("UIA_FAILURE"); return; }
    BOOL unsupported = FALSE;
    if (FAILED(uia_->CheckNotSupported(value.data, &unsupported))) { value.state = "unavailable"; return; }
    value.state = unsupported ? "unsupported" : value.data.vt == VT_EMPTY ? "unknown" : "known";
  }
  std::string booleanProperty(PROPERTYID id, bool* knownValue = nullptr, bool* valueOut = nullptr) {
    Value v; read(id, v); if (knownValue) *knownValue = false;
    if (std::string(v.state) != "known") return absent(v.state);
    if (v.data.vt != VT_BOOL || (v.data.boolVal != VARIANT_FALSE && v.data.boolVal != VARIANT_TRUE)) return absent("unavailable");
    if (knownValue) *knownValue = true; if (valueOut) *valueOut = v.data.boolVal == VARIANT_TRUE;
    return boolean(v.data.boolVal == VARIANT_TRUE);
  }
  LONG integer(PROPERTYID id) { Value v; read(id, v); return std::string(v.state) == "known" && v.data.vt == VT_I4 ? v.data.lVal : -1; }
  std::string enumeration(PROPERTYID id, const std::vector<std::string>& values) {
    Value v; read(id, v); if (std::string(v.state) != "known") return absent(v.state);
    return v.data.vt == VT_I4 && v.data.lVal >= 0 && static_cast<size_t>(v.data.lVal) < values.size() ? known(quote(values[v.data.lVal])) : absent("unavailable");
  }
  std::string stringProperty(PROPERTYID id, size_t maximum, size_t& strings) {
    Value v; read(id, v); if (std::string(v.state) != "known") return absent(v.state);
    if (v.data.vt != VT_BSTR) return absent("unavailable");
    auto result = text(v.data.bstrVal, SysStringLen(v.data.bstrVal), maximum, strings);
    if (strings >= MaxStrings) outcome_.limit("STRINGS");
    if (result == absent("redacted")) outcome_.reason("TEXT_WITHHELD");
    return result;
  }
  std::string bounds() {
    Value v; read(UIA_BoundingRectanglePropertyId, v); if (std::string(v.state) != "known") return absent(v.state);
    if (v.data.vt != (VT_ARRAY | VT_R8) || !v.data.parray || SafeArrayGetDim(v.data.parray) != 1) return absent("unavailable");
    LONG lo = 0, hi = 0;
    if (FAILED(SafeArrayGetLBound(v.data.parray, 1, &lo)) || FAILED(SafeArrayGetUBound(v.data.parray, 1, &hi)) || static_cast<int64_t>(hi) - lo != 3) return absent("unavailable");
    double values[4]{};
    for (LONG i = 0; i < 4; ++i) { LONG index = lo + i; if (FAILED(SafeArrayGetElement(v.data.parray, &index, &values[i]))) return absent("unavailable"); }
    return rectangle(values[0], values[1], values[2], values[3]);
  }
  std::string patterns() {
    const PROPERTYID ids[] = { UIA_IsInvokePatternAvailablePropertyId, UIA_IsValuePatternAvailablePropertyId, UIA_IsTextPatternAvailablePropertyId, UIA_IsSelectionPatternAvailablePropertyId, UIA_IsSelectionItemPatternAvailablePropertyId, UIA_IsTogglePatternAvailablePropertyId, UIA_IsExpandCollapsePatternAvailablePropertyId, UIA_IsScrollPatternAvailablePropertyId };
    const char* labels[] = { "invoke", "value", "text", "selection", "selection-item", "toggle", "expand-collapse", "scroll" };
    std::vector<std::string> available; std::string missing;
    for (unsigned i = 0; i < 8; ++i) {
      bool supported = false, value = false; auto observed = booleanProperty(ids[i], &supported, &value);
      if (!supported && missing.empty()) missing = observed;
      if (supported && value) available.push_back(quote(labels[i]));
    }
    return missing.empty() ? known(array(available)) : missing;
  }
};
}

bool Observation::token(HANDLE process, std::vector<BYTE>& sid, DWORD& integrity, bool& elevated) const {
  HANDLE raw = nullptr; if (!OpenProcessToken(process, TOKEN_QUERY, &raw)) return false; Handle handle(raw);
  DWORD required = 0; GetTokenInformation(raw, TokenUser, nullptr, 0, &required);
  if (!required || required > 65536) return false;
  std::vector<BYTE> user(required);
  if (!GetTokenInformation(raw, TokenUser, user.data(), required, &required)) return false;
  auto source = reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid;
  if (!IsValidSid(source)) return false; sid.resize(GetLengthSid(source));
  if (!CopySid(static_cast<DWORD>(sid.size()), sid.data(), source)) return false;
  GetTokenInformation(raw, TokenIntegrityLevel, nullptr, 0, &required);
  if (!required || required > 65536) return false;
  std::vector<BYTE> level(required);
  if (!GetTokenInformation(raw, TokenIntegrityLevel, level.data(), required, &required)) return false;
  auto levelSid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(level.data())->Label.Sid;
  if (!IsValidSid(levelSid) || !*GetSidSubAuthorityCount(levelSid)) return false;
  integrity = *GetSidSubAuthority(levelSid, *GetSidSubAuthorityCount(levelSid) - 1);
  TOKEN_ELEVATION elevation{};
  if (!GetTokenInformation(raw, TokenElevation, &elevation, sizeof(elevation), &required)) return false;
  elevated = elevation.TokenIsElevated != 0; return true;
}
bool Observation::permittedDesktop() const {
  const HDESK input = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!input) return false;
  wchar_t name[64]{}; DWORD needed = 0;
  bool permitted = GetUserObjectInformationW(input, UOI_NAME, name, sizeof(name), &needed) && std::wstring(name) == L"Default";
  CloseDesktop(input);
  permitted = permitted && GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), UOI_NAME, name, sizeof(name), &needed) && std::wstring(name) == L"Default";
  permitted = permitted && GetUserObjectInformationW(GetProcessWindowStation(), UOI_NAME, name, sizeof(name), &needed) && std::wstring(name) == L"WinSta0";
  DWORD session = 0; return permitted && ProcessIdToSessionId(GetCurrentProcessId(), &session) && session == ownSession_;
}
bool Observation::initialize(DWORD parent, const char*& reason) {
  bool elevated = false;
  if (!token(GetCurrentProcess(), ownerSid_, ownIntegrity_, elevated) || elevated || ownIntegrity_ > SECURITY_MANDATORY_MEDIUM_RID) { reason = "SELF_ELEVATED"; return false; }
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &ownSession_) || !ownSession_ || !permittedDesktop()) { reason = "INPUT_DESKTOP_RESTRICTED"; return false; }
  parentHandle_ = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent);
  DWORD parentSession = 0, integrity = 0; std::vector<BYTE> sid;
  if (!parentHandle_ || parent == GetCurrentProcessId() || !ProcessIdToSessionId(parent, &parentSession) || parentSession != ownSession_ || !token(parentHandle_, sid, integrity, elevated) || !EqualSid(ownerSid_.data(), sid.data()) || elevated || integrity > ownIntegrity_) { reason = "HELPER_UNAVAILABLE"; return false; }
  parentPid_ = parent; sessionEnd_ = GetTickCount64() + SessionMs;
  if (FAILED(CoCreateInstance(CLSID_CUIAutomation8, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&uia_))) ||
      FAILED(uia_->put_AutoSetFocus(FALSE)) || FAILED(uia_->put_ConnectionTimeout(500)) || FAILED(uia_->put_TransactionTimeout(250)) || FAILED(uia_->get_RawViewWalker(&walker_))) { reason = "UIA_UNAVAILABLE"; return false; }
  return true;
}
Observation::~Observation() { if (parentHandle_) CloseHandle(parentHandle_); }
bool Observation::identity(HWND window, Identity& result) const {
  if (!window || !IsWindow(window) || !GetWindowThreadProcessId(window, &result.pid) || !result.pid || result.pid == parentPid_ || result.pid == GetCurrentProcessId()) return false;
  if (!ProcessIdToSessionId(result.pid, &result.session) || result.session != ownSession_) return false;
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, result.pid)); if (!process.value) return false;
  std::vector<BYTE> sid;
  if (!token(process.value, sid, result.integrity, result.elevated) || !EqualSid(const_cast<BYTE*>(ownerSid_.data()), sid.data())) return false;
  FILETIME exited{}, kernel{}, user{};
  if (!GetProcessTimes(process.value, &result.created, &exited, &kernel, &user)) return false;
  wchar_t full[32768]{}; DWORD length = 32768;
  if (!QueryFullProcessImageNameW(process.value, 0, full, &length)) return false;
  std::wstring file(full, length); const auto slash = file.find_last_of(L"\\/");
  result.application = file.substr(slash == std::wstring::npos ? 0 : slash + 1);
  SecureZeroMemory(full, sizeof(full));
  const auto base = lower(result.application);
  if (base == L"momo.exe" || base == L"momo-desktop-observer.exe" || base == L"shellexperiencehost.exe" || base == L"startmenuexperiencehost.exe" || base == L"searchhost.exe" || base == L"textinputhost.exe" || base == L"lockapp.exe" || base == L"systemsettingsadminflows.exe") return false;
  result.window = window; return true;
}
bool Observation::eligible(HWND window, Identity& result) const {
  if (!IsWindowVisible(window) || GetAncestor(window, GA_ROOT) != window) return false;
  const auto style = GetWindowLongPtrW(window, GWL_STYLE), extended = GetWindowLongPtrW(window, GWL_EXSTYLE);
  if ((style & WS_CHILD) || (extended & WS_EX_TOOLWINDOW) || (extended & WS_EX_NOACTIVATE)) return false;
  DWORD cloaked = 0;
  if (FAILED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) || cloaked) return false;
  wchar_t type[128]{}; if (!GetClassNameW(window, type, 128)) return false;
  const std::wstring cls(type);
  if (cls == L"Progman" || cls == L"WorkerW" || cls == L"Shell_TrayWnd" || cls == L"Shell_SecondaryTrayWnd" || cls == L"DV2ControlHost" || cls == L"Windows.UI.Core.CoreWindow" || cls == L"XamlExplorerHostIslandWindow" || cls == L"ForegroundStaging") return false;
  return identity(window, result);
}
bool Observation::matches(const Identity& value) const {
  Identity current;
  return !value.destroyed && value.generation == generation_ && value.expires > GetTickCount64() && eligible(value.window, current) && current.pid == value.pid && current.session == value.session && sameTime(current.created, value.created) && current.integrity == value.integrity && current.elevated == value.elevated;
}
void Observation::destroyed(HWND window) {
  bool selectedDestroyed = false;
  {
    std::lock_guard<std::mutex> lock(targetsMutex_);
    for (auto& pair : targets_) if (pair.second.window == window) { pair.second.destroyed = true; if (pair.first == selected_) selectedDestroyed = true; }
  }
  if (selectedDestroyed) send("invalidated", 0, "{\"reason\":\"TARGET_STALE\"}");
}
bool Observation::bind(const std::string& target, Identity& result, bool authorized) {
  std::lock_guard<std::mutex> lock(targetsMutex_);
  const auto it = targets_.find(target);
  if (it == targets_.end() || (authorized && selected_ != target) || !matches(it->second)) return false;
  result = it->second; return true;
}
std::string Observation::windowJson(const Identity& value, const std::string& id, unsigned ordinal, size_t& strings) const {
  RECT rect{}; const auto bounds = GetWindowRect(value.window, &rect) ? rectangle(rect.left, rect.top, static_cast<double>(rect.right) - rect.left, static_cast<double>(rect.bottom) - rect.top) : absent("unavailable");
  const HWND foreground = GetForegroundWindow();
  return "{\"nativeId\":" + quote(id) + ",\"pid\":" + std::to_string(value.pid) + ",\"application\":" + text(value.application.c_str(), value.application.size(), 80, strings) + ",\"windowOrdinal\":" + std::to_string(ordinal) + ",\"visible\":" + boolean(IsWindowVisible(value.window) != FALSE) + ",\"state\":" + known(quote(IsIconic(value.window) ? "minimized" : IsZoomed(value.window) ? "maximized" : "normal")) + ",\"foreground\":" + (foreground ? boolean(foreground == value.window) : absent("unavailable")) + ",\"containsKeyboardFocus\":" + (!foreground ? absent("unavailable") : foreground == value.window ? containsFocus(value.window) : boolean(false)) + ",\"bounds\":" + bounds + ",\"elevation\":" + known(quote(value.elevated || value.integrity > ownIntegrity_ ? "elevated" : "standard")) + ",\"accessibility\":" + quote(value.elevated || value.integrity > ownIntegrity_ ? "RESTRICTED" : "not-checked") + "}";
}
bool Observation::list(uint32_t sequence) {
  Outcome outcome;
  struct Enumeration { Observation* owner; Outcome* outcome; unsigned examined = 0; std::set<HWND> seen; std::vector<Identity> windows; } enumeration{ this, &outcome, 0, {}, {} };
  const auto consider = [](Enumeration& e, HWND window) -> bool {
    if (e.examined >= MaxCandidates) { e.outcome->limit("CANDIDATES"); return false; }
    if (GetTickCount64() - e.outcome->started >= EnumerationMs) { e.outcome->limit("TIME"); return false; }
    ++e.examined;
    if (e.windows.size() >= MaxWindows) { e.outcome->limit("WINDOWS"); return false; }
    if (e.seen.insert(window).second) { Identity value; if (e.owner->eligible(window, value)) e.windows.push_back(value); }
    return true;
  };
  // EnumWindows has no title query and includes minimized visible windows and owned dialogs.
  struct Callback { Enumeration* enumeration; decltype(consider)* consider; } callback{ &enumeration, &consider };
  EnumWindows([](HWND window, LPARAM raw) -> BOOL { auto& c = *reinterpret_cast<Callback*>(raw); return (*c.consider)(*c.enumeration, window) ? TRUE : FALSE; }, reinterpret_cast<LPARAM>(&callback));
  // Reconcile only raw root direct children. Never query desktop descendants or strings.
  if (enumeration.examined < MaxCandidates && enumeration.windows.size() < MaxWindows && GetTickCount64() - outcome.started < EnumerationMs) {
    ComPtr<IUIAutomationElement> root, child;
    if (SUCCEEDED(uia_->GetRootElement(&root)) && SUCCEEDED(walker_->GetFirstChildElement(root.Get(), &child))) {
      while (child && enumeration.examined < MaxCandidates && enumeration.windows.size() < MaxWindows && GetTickCount64() - outcome.started < EnumerationMs) {
        VARIANT handle{}; VariantInit(&handle);
        if (SUCCEEDED(child->GetCurrentPropertyValueEx(UIA_NativeWindowHandlePropertyId, TRUE, &handle)) && handle.vt == VT_I4 && handle.lVal) consider(enumeration, reinterpret_cast<HWND>(static_cast<ULONG_PTR>(static_cast<ULONG>(handle.lVal))));
        else ++enumeration.examined;
        VariantClear(&handle);
        ComPtr<IUIAutomationElement> next;
        if (FAILED(walker_->GetNextSiblingElement(child.Get(), &next))) { outcome.reason("UIA_FAILURE"); break; }
        child = next;
      }
      if (child) outcome.limit(GetTickCount64() - outcome.started >= EnumerationMs ? "TIME" : enumeration.examined >= MaxCandidates ? "CANDIDATES" : "WINDOWS");
    } else outcome.reason("UIA_FAILURE");
  }
  if (!permittedDesktop()) return fault(sequence, "INPUT_DESKTOP_RESTRICTED");
  std::sort(enumeration.windows.begin(), enumeration.windows.end(), [](const Identity& a, const Identity& b) { if (a.pid != b.pid) return a.pid < b.pid; return reinterpret_cast<ULONG_PTR>(a.window) < reinterpret_cast<ULONG_PTR>(b.window); });
  std::vector<std::string> windows; size_t strings = 0; std::map<DWORD, unsigned> ordinals;
  {
    std::lock_guard<std::mutex> lock(targetsMutex_);
    targets_.clear(); selected_.clear(); ++generation_;
    for (auto value : enumeration.windows) {
      value.generation = generation_; value.expires = std::min(sessionEnd_, GetTickCount64() + CatalogMs);
      if (!matches(value)) { outcome.reason("TARGET_STALE"); continue; }
      const auto id = uuid(); if (id.empty()) return fault(sequence, "INTERNAL_FAILURE");
      windows.push_back(windowJson(value, id, ++ordinals[value.pid], strings));
      value.application.clear(); targets_.emplace(id, value); // Bind identity only; never cache catalog labels.
    }
  }
  return send("catalog", sequence, "{" + outcome.metadata() + ",\"windows\":" + array(windows) + ",\"examinedCandidates\":" + std::to_string(enumeration.examined) + "}");
}
bool Observation::authorize(uint32_t sequence, const std::string& target) {
  Identity value;
  { std::lock_guard<std::mutex> lock(targetsMutex_); selected_.clear(); }
  if (!bind(target, value, false)) return send("bound", sequence, "{\"status\":\"STALE\",\"reason\":\"TARGET_STALE\"}");
  if (value.elevated || value.integrity > ownIntegrity_) return send("bound", sequence, "{\"status\":\"RESTRICTED\",\"reason\":\"TARGET_RESTRICTED\"}");
  if (!permittedDesktop()) return fault(sequence, "INPUT_DESKTOP_RESTRICTED");
  { std::lock_guard<std::mutex> lock(targetsMutex_); if (!matches(targets_.at(target))) return fault(sequence, "TARGET_STALE"); selected_ = target; targets_.at(target).expires = sessionEnd_; }
  return send("bound", sequence, "{\"status\":\"AVAILABLE\",\"reason\":null}");
}
bool Observation::observe(uint32_t sequence, const std::string& target) {
  Outcome outcome; Identity value;
  if (!bind(target, value, true)) return fault(sequence, "TARGET_STALE");
  if (value.elevated || value.integrity > ownIntegrity_) return fault(sequence, "TARGET_RESTRICTED");
  const HWND foreground = GetForegroundWindow(); const bool focusedTarget = foreground == value.window;
  ComPtr<IUIAutomationElement> root;
  if (FAILED(uia_->ElementFromHandle(value.window, &root)) || !root) return fault(sequence, "UIA_UNAVAILABLE");
  struct Frame { ComPtr<IUIAutomationElement> element; int parent; unsigned depth; };
  std::vector<Frame> stack; stack.push_back({ root, -1, 0 });
  std::vector<std::string> nodes; size_t strings = 0, bytes = 0; unsigned visited = 0; int focusedNode = -1; bool ambiguousFocus = false;
  while (!stack.empty()) {
    if (visited >= MaxNodes) { outcome.limit("NODES"); break; }
    if (GetTickCount64() - outcome.started >= TreeMs) { outcome.limit("TIME"); break; }
    Frame frame = stack.back(); stack.pop_back();
    if (!send("progress", sequence, "{\"node\":" + std::to_string(visited) + "}")) return false;
    ++visited;
    Properties p(uia_.Get(), frame.element.Get(), outcome);
    // Refuse provider nodes crossing into another process/window before label/state collection.
    // Hosted cross-process descendants are conservatively partial in 7B.1.
    const LONG nodeProcess = p.integer(UIA_ProcessIdPropertyId);
    const LONG nativeWindow = p.integer(UIA_NativeWindowHandlePropertyId);
    if (nodeProcess <= 0 || static_cast<DWORD>(nodeProcess) != value.pid ||
        (nativeWindow > 0 && GetAncestor(reinterpret_cast<HWND>(static_cast<ULONG_PTR>(static_cast<ULONG>(nativeWindow))), GA_ROOT) != value.window)) {
      outcome.reason("TARGET_RESTRICTED"); break;
    }
    // Protection is read before role/state and before every potential string access.
    bool protectionKnown = false, protectedValue = false;
    auto protectedContent = p.booleanProperty(UIA_IsPasswordPropertyId, &protectionKnown, &protectedValue);
    const std::string type = role(p.integer(UIA_ControlTypePropertyId));
    bool boundary = !protectionKnown || protectedValue || contentBoundary(type);
    if (!protectionKnown || protectedValue) outcome.reason("PROTECTED_CONTENT");
    const auto enabled = p.booleanProperty(UIA_IsEnabledPropertyId), offscreen = p.booleanProperty(UIA_IsOffscreenPropertyId), focusable = p.booleanProperty(UIA_IsKeyboardFocusablePropertyId);
    bool focusKnown = false, hasFocus = false;
    auto focus = p.booleanProperty(UIA_HasKeyboardFocusPropertyId, &focusKnown, &hasFocus);
    if (!focusedTarget) focus = absent("unavailable");
    const auto readOnly = p.booleanProperty(UIA_ValueIsReadOnlyPropertyId), selected = p.booleanProperty(UIA_SelectionItemIsSelectedPropertyId);
    const auto toggle = p.enumeration(UIA_ToggleToggleStatePropertyId, { "off", "on", "indeterminate" });
    const auto expansion = p.enumeration(UIA_ExpandCollapseExpandCollapseStatePropertyId, { "collapsed", "expanded", "partial", "leaf" });
    const auto bounds = p.bounds(), patterns = p.patterns();
    auto name = absent("redacted"), automationId = absent("redacted"), className = absent("redacted");
    if (protectionKnown && !protectedValue && functional(type)) {
      name = p.stringProperty(UIA_NamePropertyId, 160, strings);
      automationId = p.stringProperty(UIA_AutomationIdPropertyId, 80, strings);
      className = p.stringProperty(UIA_ClassNamePropertyId, 80, strings);
      // A changing protection flag cannot release the previously read strings.
      bool checked = false, secured = false; const auto rechecked = p.booleanProperty(UIA_IsPasswordPropertyId, &checked, &secured);
      if (!checked || secured) { protectedContent = rechecked; boundary = true; name = automationId = className = absent("redacted"); outcome.reason("PROTECTED_CONTENT"); }
      if (type != role(p.integer(UIA_ControlTypePropertyId))) { protectedContent = absent("unknown"); boundary = true; name = automationId = className = absent("redacted"); outcome.reason("TEXT_WITHHELD"); }
      if (p.integer(UIA_ProcessIdPropertyId) != nodeProcess) { protectedContent = absent("unknown"); boundary = true; name = automationId = className = absent("redacted"); outcome.reason("TARGET_RESTRICTED"); }
    }
    const auto index = static_cast<int>(nodes.size());
    const std::string node = "{\"id\":\"n" + std::to_string(index) + "\",\"parentId\":" + (frame.parent < 0 ? "null" : quote("n" + std::to_string(frame.parent))) + ",\"role\":" + quote(type) + ",\"name\":" + name + ",\"automationId\":" + automationId + ",\"className\":" + className + ",\"enabled\":" + enabled + ",\"offscreen\":" + offscreen + ",\"keyboardFocusable\":" + focusable + ",\"hasKeyboardFocus\":" + focus + ",\"readOnly\":" + readOnly + ",\"selected\":" + selected + ",\"toggle\":" + toggle + ",\"expansion\":" + expansion + ",\"bounds\":" + bounds + ",\"patterns\":" + patterns + ",\"protectedContent\":" + protectedContent + "}";
    // Reserve space for main's catalog/freshness/diagnostics within the 256 KiB public response.
    if (bytes + node.size() > 180 * 1024) { outcome.limit("BYTES"); break; }
    nodes.push_back(node); bytes += node.size() + 1;
    if (focusedTarget && focusKnown && hasFocus) { if (focusedNode >= 0) { ambiguousFocus = true; outcome.reason("FOCUS_UNAVAILABLE"); } else focusedNode = index; }
    if (GetTickCount64() - outcome.started >= TreeMs) outcome.limit("TIME");
    // Incremental raw traversal counts every visited node; content boundaries have no descendants.
    // Siblings are queued one at a time, never through FindAll or descendant queries.
    if (frame.parent >= 0 && GetTickCount64() - outcome.started < TreeMs) {
      ComPtr<IUIAutomationElement> sibling;
      if (SUCCEEDED(walker_->GetNextSiblingElement(frame.element.Get(), &sibling))) { if (sibling) stack.push_back({ sibling, frame.parent, frame.depth }); }
      else outcome.reason("UIA_FAILURE");
    }
    if (!boundary && GetTickCount64() - outcome.started < TreeMs) {
      if (frame.depth == MaxDepth) outcome.limit("DEPTH");
      else {
        ComPtr<IUIAutomationElement> child;
        if (SUCCEEDED(walker_->GetFirstChildElement(frame.element.Get(), &child))) { if (child) stack.push_back({ child, index, frame.depth + 1 }); }
        else outcome.reason("UIA_FAILURE");
      }
    }
  }
  if (!bind(target, value, true)) return fault(sequence, "TARGET_STALE");
  if (!permittedDesktop()) return fault(sequence, "INPUT_DESKTOP_RESTRICTED");
  const HWND finalForeground = GetForegroundWindow();
  const bool stableForeground = foreground && finalForeground == foreground;
  const auto targetForeground = stableForeground ? boolean(focusedTarget) : absent("unavailable");
  const auto targetFocus = stableForeground ? (focusedTarget ? containsFocus(value.window) : boolean(false)) : absent("unavailable");
  std::string focus = "{\"state\":\"outside-target\"}";
  if (!foreground || ambiguousFocus) { focus = absent("unavailable"); outcome.reason("FOCUS_UNAVAILABLE"); }
  else if (!stableForeground) { focus = absent("unavailable"); outcome.reason("FOCUS_CHANGED"); }
  else if (focusedTarget) focus = focusedNode >= 0 && targetFocus == boolean(true) ? "{\"state\":\"in-target\",\"nodeId\":\"n" + std::to_string(focusedNode) + "\"}" : absent("omitted");
  return send("tree", sequence, "{" + outcome.metadata() + ",\"nodes\":" + array(nodes) + ",\"focus\":" + focus + ",\"foreground\":" + targetForeground + ",\"containsKeyboardFocus\":" + targetFocus + ",\"visitedNodes\":" + std::to_string(visited) + "}");
}
}
