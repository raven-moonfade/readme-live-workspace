#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#define MyAppName "ReadMe"
#define MyAppPublisher "raven-moonfade"
#define MyAppExeName "ReadMe.exe"

[Setup]
AppId={{E5B8C6B3-6A0C-4E2B-9E2D-6F4C1A7D3B91}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={code:GetDefaultDir}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=ReadMe-Setup-{#MyAppVersion}
SetupIconFile=..\assets\app.ico
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
CloseApplicationsFilter={#MyAppExeName}
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加图标："; Flags: checkedonce

[Files]
Source: "..\dist\ReadMe\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\ReadMe"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\ReadMe"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "启动 ReadMe"; Flags: nowait postinstall skipifsilent

[Code]
function GetDefaultDir(Param: string): string;
begin
  if DirExists('D:\AppPath') then
    Result := 'D:\AppPath\ReadMe'
  else
    Result := ExpandConstant('{localappdata}\Programs\ReadMe');
end;
