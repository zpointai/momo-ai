#include <windows.h>
#include <shellapi.h>
#include <array>
#include <cwchar>
#include "resource.h"

// One explicit owner dialog. No shell, network, files, logging or credential store access.
struct Entry {
    bool pairing = false;
    std::array<wchar_t, 257> first{};
    std::array<wchar_t, 257> second{};
    ~Entry() {
        SecureZeroMemory(first.data(), sizeof(first));
        SecureZeroMemory(second.data(), sizeof(second));
    }
};

bool printable(const wchar_t* text, size_t minimum) {
    const size_t length = wcslen(text);
    if (length < minimum || length > 256) return false;
    for (size_t i = 0; i < length; ++i) if (text[i] < 0x21 || text[i] > 0x7e) return false;
    return true;
}

bool validSid(const wchar_t* sid) {
    if (wcslen(sid) != 34 || sid[0] != L'S' || sid[1] != L'K') return false;
    for (size_t i = 2; i < 34; ++i) {
        const wchar_t c = sid[i];
        if (!((c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f') || (c >= L'A' && c <= L'F'))) return false;
    }
    return true;
}

void clearControls(HWND dialog) {
    SetDlgItemTextW(dialog, IDC_FIRST, L"");
    SetDlgItemTextW(dialog, IDC_SECOND, L"");
}

INT_PTR CALLBACK setupDialog(HWND dialog, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* entry = reinterpret_cast<Entry*>(GetWindowLongPtrW(dialog, DWLP_USER));
    if (message == WM_INITDIALOG) {
        entry = reinterpret_cast<Entry*>(lParam);
        SetWindowLongPtrW(dialog, DWLP_USER, lParam);
        SendDlgItemMessageW(dialog, IDC_FIRST, EM_SETLIMITTEXT, 256, 0);
        SendDlgItemMessageW(dialog, IDC_SECOND, EM_SETLIMITTEXT, 256, 0);
        if (entry->pairing) {
            SetDlgItemTextW(dialog, IDC_INTRO, L"Enter the saved Relay pairing token. This connects this desktop to your Relay gateway.");
            SetDlgItemTextW(dialog, IDC_FIRST_LABEL, L"Relay pairing token (32 or more characters)");
            SendDlgItemMessageW(dialog, IDC_FIRST, EM_SETPASSWORDCHAR, 0x25cf, 0);
            ShowWindow(GetDlgItem(dialog, IDC_SECOND_LABEL), SW_HIDE);
            ShowWindow(GetDlgItem(dialog, IDC_SECOND), SW_HIDE);
            SetDlgItemTextW(dialog, IDOK, L"Pair desktop");
        }
        // An owned native dialog stays above MoMo without minimizing the app.
        RECT area{}, bounds{};
        MONITORINFO monitor{sizeof(MONITORINFO)};
        if (GetMonitorInfoW(MonitorFromWindow(GetWindow(dialog, GW_OWNER), MONITOR_DEFAULTTOPRIMARY), &monitor)) area = monitor.rcWork;
        else SystemParametersInfoW(SPI_GETWORKAREA, 0, &area, 0);
        GetWindowRect(dialog, &bounds);
        SetWindowPos(dialog, HWND_TOP, area.left + ((area.right - area.left) - (bounds.right - bounds.left)) / 2,
            area.top + ((area.bottom - area.top) - (bounds.bottom - bounds.top)) / 2, 0, 0, SWP_NOSIZE);
        SetForegroundWindow(dialog);
        SetFocus(GetDlgItem(dialog, IDC_FIRST));
        return FALSE;
    }
    if (!entry) return FALSE;
    if (message == WM_CLOSE || (message == WM_COMMAND && LOWORD(wParam) == IDCANCEL)) {
        clearControls(dialog);
        EndDialog(dialog, IDCANCEL);
        return TRUE;
    }
    if (message == WM_COMMAND && LOWORD(wParam) == IDOK) {
        GetDlgItemTextW(dialog, IDC_FIRST, entry->first.data(), static_cast<int>(entry->first.size()));
        GetDlgItemTextW(dialog, IDC_SECOND, entry->second.data(), static_cast<int>(entry->second.size()));
        const bool valid = entry->pairing ? printable(entry->first.data(), 32)
            : validSid(entry->first.data()) && printable(entry->second.data(), 16);
        if (!valid) {
            SecureZeroMemory(entry->first.data(), sizeof(entry->first));
            SecureZeroMemory(entry->second.data(), sizeof(entry->second));
            SetDlgItemTextW(dialog, IDC_STATUS, entry->pairing ? L"Use the saved Relay pairing token (32-256 characters)."
                : L"Use the SK API Key SID and its matching API Key Secret. Do not use an AC SID or Account Auth Token.");
            return TRUE;
        }
        clearControls(dialog);
        EndDialog(dialog, IDOK);
        return TRUE;
    }
    return FALSE;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int) {
    // Refuse standalone/console use: credentials only leave through the parent's pipe.
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output == INVALID_HANDLE_VALUE || output == nullptr || GetFileType(output) != FILE_TYPE_PIPE) return 1;
    int argc = 0;
    auto** args = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!args) return 1;
    Entry entry;
    const bool validPurpose = argc == 3 && (wcscmp(args[1], L"rest") == 0 || wcscmp(args[1], L"pair") == 0);
    HWND owner = nullptr;
    bool validOwner = false;
    if (validPurpose) {
        entry.pairing = wcscmp(args[1], L"pair") == 0;
        wchar_t* end = nullptr;
        const auto handle = wcstoull(args[2], &end, 10);
        owner = reinterpret_cast<HWND>(static_cast<UINT_PTR>(handle));
        validOwner = end && *end == L'\0' && owner && IsWindow(owner);
    }
    LocalFree(args);
    if (!validPurpose || !validOwner) return 1;
    const auto result = DialogBoxParamW(instance, MAKEINTRESOURCEW(IDD_SETUP), owner, setupDialog, reinterpret_cast<LPARAM>(&entry));
    if (result == IDCANCEL) return 2;
    if (result != IDOK) return 1;

    // Bounded binary frame: magic + little-endian lengths + printable ASCII fields.
    std::array<unsigned char, 524> frame{};
    frame[0] = 'M'; frame[1] = 'R'; frame[2] = '0'; frame[3] = '1';
    const DWORD firstLength = static_cast<DWORD>(wcslen(entry.first.data()));
    const DWORD secondLength = entry.pairing ? 0 : static_cast<DWORD>(wcslen(entry.second.data()));
    for (unsigned int i = 0; i < 4; ++i) {
        frame[4 + i] = static_cast<unsigned char>((firstLength >> (8 * i)) & 0xff);
        frame[8 + i] = static_cast<unsigned char>((secondLength >> (8 * i)) & 0xff);
    }
    for (DWORD i = 0; i < firstLength; ++i) frame[12 + i] = static_cast<unsigned char>(entry.first[i]);
    for (DWORD i = 0; i < secondLength; ++i) frame[12 + firstLength + i] = static_cast<unsigned char>(entry.second[i]);
    const DWORD size = 12 + firstLength + secondLength;
    DWORD written = 0;
    const bool sent = WriteFile(output, frame.data(), size, &written, nullptr) && written == size;
    SecureZeroMemory(frame.data(), sizeof(frame));
    return sent ? 0 : 1;
}
