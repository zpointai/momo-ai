#pragma once
#include "protocol.h"
#include <atomic>
#include <map>

namespace observer {
struct Identity {
  HWND window = nullptr;
  DWORD pid = 0, session = 0, integrity = 0;
  FILETIME created{};
  bool elevated = false, destroyed = false;
  uint64_t generation = 0;
  ULONGLONG expires = 0;
  std::wstring application;
};
class Observation final {
public:
  bool initialize(DWORD parent, const char*& reason);
  bool list(uint32_t sequence);
  bool authorize(uint32_t sequence, const std::string& target);
  bool observe(uint32_t sequence, const std::string& target);
  bool permittedDesktop() const;
  void destroyed(HWND window);
  DWORD parentPid() const { return parentPid_; }
  HANDLE parentHandle() const { return parentHandle_; }
  ~Observation();
private:
  bool identity(HWND window, Identity& result) const;
  bool matches(const Identity& identity) const;
  bool eligible(HWND window, Identity& result) const;
  bool token(HANDLE process, std::vector<BYTE>& sid, DWORD& integrity, bool& elevated) const;
  bool bind(const std::string& target, Identity& result, bool authorized);
  std::string windowJson(const Identity& value, const std::string& id, unsigned ordinal, size_t& strings) const;
  std::vector<BYTE> ownerSid_;
  DWORD ownSession_ = 0, ownIntegrity_ = 0, parentPid_ = 0;
  HANDLE parentHandle_ = nullptr;
  ComPtr<IUIAutomation2> uia_;
  ComPtr<IUIAutomationTreeWalker> walker_;
  std::map<std::string, Identity> targets_;
  std::string selected_;
  std::mutex targetsMutex_;
  uint64_t generation_ = 0;
  ULONGLONG sessionEnd_ = 0;
};
}
