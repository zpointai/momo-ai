#include "observation.h"
#include <thread>
#include <cstring>

static_assert(sizeof(void*) == 8, "Desktop Observer requires x64");
namespace observer {
static std::mutex outputMutex;
static Observation* active = nullptr;
static bool readExact(void* data, DWORD length) {
  auto bytes = static_cast<BYTE*>(data);
  while (length) { DWORD count = 0; if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, length, &count, nullptr) || !count) return false; bytes += count; length -= count; }
  return true;
}
bool readRequest(Request& request, uint32_t expectedSequence) {
  uint32_t length = 0;
  if (!readExact(&length, 4) || (length != 6 && length != 10 && length != 42)) return false;
  BYTE bytes[42]{};
  if (!readExact(bytes, length) || bytes[0] != Protocol || bytes[1] < 1 || bytes[1] > 4) return false;
  request.op = static_cast<Operation>(bytes[1]); std::memcpy(&request.sequence, bytes + 2, 4);
  if (request.sequence != expectedSequence || length != (bytes[1] == 1 ? 10u : bytes[1] >= 3 ? 42u : 6u)) return false;
  if (request.op == Operation::Hello) std::memcpy(&request.parent, bytes + 6, 4);
  if (bytes[1] >= 3) {
    request.target.assign(reinterpret_cast<char*>(bytes + 6), 36);
    for (size_t i = 0; i < 36; ++i) {
      const char c = request.target[i];
      if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return false; }
      else if (!(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')) return false;
    }
  }
  return true;
}
std::string quote(const std::string& value) {
  std::string result = "\"";
  for (unsigned char c : value) { if (c == '\\' || c == '"') result += '\\'; if (c < 32) return "\"\""; result += static_cast<char>(c); }
  return result + '"';
}
std::string text(const wchar_t* value, size_t count, size_t maximum, size_t& aggregate) {
  if (!value || count > maximum) return absent("redacted");
  for (size_t i = 0; i < count; ++i) {
    const wchar_t c = value[i];
    if (c < 32 || (c >= 127 && c <= 159) || (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return absent("redacted");
  }
  if (!count) return known("\"\"");
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(count), nullptr, 0, nullptr, nullptr);
  if (!size) return absent("unavailable");
  if (aggregate + static_cast<size_t>(size) > MaxStrings) { aggregate = MaxStrings; return absent("redacted"); }
  std::string result(size, '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, static_cast<int>(count), &result[0], size, nullptr, nullptr) != size) return absent("unavailable");
  aggregate += size; return known(quote(result));
}
bool send(const char* kind, uint32_t sequence, const std::string& data) {
  const std::string output = "{\"protocol\":1,\"helperVersion\":\"0.1.0\",\"buildId\":\"" OBSERVER_BUILD_ID "\",\"sequence\":" + std::to_string(sequence) + ",\"kind\":" + quote(kind) + ",\"data\":" + data + "}";
  if (output.size() > MaxResponse) return false;
  const auto length = static_cast<DWORD>(output.size());
  std::lock_guard<std::mutex> lock(outputMutex);
  const HANDLE pipe = GetStdHandle(STD_OUTPUT_HANDLE);
  DWORD written = 0;
  return WriteFile(pipe, &length, 4, &written, nullptr) && written == 4 && WriteFile(pipe, output.data(), length, &written, nullptr) && written == length;
}
bool fault(uint32_t sequence, const char* reason) { return send("fault", sequence, "{\"reason\":" + quote(reason) + "}"); }
static void CALLBACK destroyedEvent(HWINEVENTHOOK, DWORD, HWND window, LONG object, LONG child, DWORD, DWORD) {
  if (active && object == OBJID_WINDOW && child == CHILDID_SELF) active->destroyed(window);
}
}
int main() {
  using namespace observer;
  // Private anonymous pipes only; an interactive or redirected-to-file launch is refused.
  if (GetFileType(GetStdHandle(STD_INPUT_HANDLE)) != FILE_TYPE_PIPE || GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE) return 2;
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 3;
  int exitCode = 0;
  {
    Observation observation;
    Request first{};
    if (!readRequest(first, 1) || first.op != Operation::Hello) { CoUninitialize(); return 4; }
    const char* reason = "HELPER_UNAVAILABLE";
    if (!observation.initialize(first.parent, reason)) { fault(first.sequence, reason); return 5; }
    active = &observation;
    std::atomic<bool> stopped{false};
    std::atomic<bool> hookReady{false}, hookSucceeded{false};
    const ULONGLONG end = GetTickCount64() + SessionMs;
    std::thread monitor([&]() {
      const auto hook = SetWinEventHook(EVENT_OBJECT_DESTROY, EVENT_OBJECT_DESTROY, nullptr, destroyedEvent, 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
      hookSucceeded = hook != nullptr; hookReady = true;
      while (!stopped) {
        MSG message{};
        unsigned dispatched = 0;
        while (dispatched++ < 1024 && PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&message); DispatchMessageW(&message); }
        if (WaitForSingleObject(observation.parentHandle(), 100) != WAIT_TIMEOUT || GetTickCount64() >= end) ExitProcess(0);
        if (!observation.permittedDesktop()) { send("invalidated", 0, "{\"reason\":\"SYSTEM_SESSION_CHANGED\"}"); ExitProcess(0); }
      }
      if (hook) UnhookWinEvent(hook);
    });
    while (!hookReady) Sleep(1);
    if (!hookSucceeded) { fault(1, "HELPER_UNAVAILABLE"); stopped = true; monitor.join(); return 6; }
    if (!send("ready", 1, "{\"architecture\":\"x64\"}")) exitCode = 7;
    uint32_t sequence = 2;
    while (!exitCode && sequence) {
      Request request{};
      if (!readRequest(request, sequence++) || request.op == Operation::Hello) break;
      if (!observation.permittedDesktop()) { fault(request.sequence, "INPUT_DESKTOP_RESTRICTED"); break; }
      bool sent = false;
      switch (request.op) {
        case Operation::List: sent = observation.list(request.sequence); break;
        case Operation::Authorize: sent = observation.authorize(request.sequence, request.target); break;
        case Operation::Observe: sent = observation.observe(request.sequence, request.target); break;
        default: break;
      }
      if (!sent) break;
    }
    stopped = true; monitor.join(); active = nullptr;
  }
  CoUninitialize(); return exitCode;
}
