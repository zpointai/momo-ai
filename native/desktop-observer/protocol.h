#pragma once
#include <Windows.h>
#include <Objbase.h>
#include <OleAuto.h>
#include <UIAutomation.h>
#include <wrl/client.h>
#include <string>
#include <vector>
#include <mutex>
#include <cstdint>
#include <algorithm>
#include <cmath>

namespace observer {
using Microsoft::WRL::ComPtr;
constexpr unsigned Protocol = 1;
constexpr char Version[] = "0.1.0";
constexpr size_t MaxResponse = 262144, MaxStrings = 16384;
constexpr unsigned MaxCandidates = 1024, MaxWindows = 64, MaxNodes = 512, MaxDepth = 12, MaxProperties = 32;
constexpr ULONGLONG SessionMs = 300000, CatalogMs = 30000, TreeMs = 2000, EnumerationMs = 1000;
// Closed binary input vocabulary. No selectors, property IDs, native handles or action tags.
enum class Operation : uint8_t { Hello = 1, List = 2, Authorize = 3, Observe = 4 };
struct Request { Operation op; uint32_t sequence; DWORD parent = 0; std::string target; };
bool readRequest(Request& request, uint32_t expectedSequence);
bool send(const char* kind, uint32_t sequence, const std::string& data);
bool fault(uint32_t sequence, const char* reason);
std::string quote(const std::string& value);
std::string text(const wchar_t* value, size_t count, size_t maximum, size_t& aggregate);
inline std::string absent(const char* state) { return "{\"state\":" + quote(state) + "}"; }
inline std::string known(const std::string& json) { return "{\"state\":\"known\",\"value\":" + json + "}"; }
inline std::string boolean(bool value) { return known(value ? "true" : "false"); }
inline std::string number(double value) { return std::to_string(value); }
inline std::string rectangle(double x, double y, double width, double height) {
  if (!std::isfinite(x) || !std::isfinite(y) || !std::isfinite(width) || !std::isfinite(height) || std::abs(x) > 1000000 || std::abs(y) > 1000000 || width < 0 || height < 0 || width > 1000000 || height > 1000000) return absent("unavailable");
  return known("{\"x\":" + number(x) + ",\"y\":" + number(y) + ",\"width\":" + number(width) + ",\"height\":" + number(height) + "}");
}
inline std::string array(const std::vector<std::string>& values) {
  std::string out = "["; for (const auto& v : values) { if (out.size() > 1) out += ','; out += v; } return out + ']';
}
struct Outcome {
  ULONGLONG started = GetTickCount64();
  std::vector<std::string> reasons, limits;
  void reason(const char* value) { auto q = quote(value); if (std::find(reasons.begin(), reasons.end(), q) == reasons.end() && reasons.size() < 12) reasons.push_back(q); }
  void limit(const char* value) { auto q = quote(value); if (std::find(limits.begin(), limits.end(), q) == limits.end() && limits.size() < 8) limits.push_back(q); reason("LIMIT_REACHED"); }
  std::string metadata(const char* status = nullptr) const {
    return "\"status\":" + quote(status ? status : reasons.empty() ? "AVAILABLE" : "PARTIAL") + ",\"reasons\":" + array(reasons) + ",\"limitsHit\":" + array(limits) + ",\"elapsedMs\":" + std::to_string(std::min<ULONGLONG>(3000, GetTickCount64() - started));
  }
};
}
