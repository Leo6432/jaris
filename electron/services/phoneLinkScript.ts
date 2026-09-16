/** Identifiants relevés sur Mobile connecté 1.26072.255.0. Aucune coordonnée ni donnée interpolée. */
export const PHONE_LINK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
$attempted = $false
try {
  $request = [Console]::ReadLine() | ConvertFrom-Json
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  Add-Type -Namespace JarisPhone -Name Native -MemberDefinition '
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);'
  $auto = [System.Windows.Automation.AutomationElement]
  $scope = [System.Windows.Automation.TreeScope]::Descendants
  $phoneProc = $null
  for ($i=0; $i -lt 60; $i++) {
    $candidates = @(Get-Process PhoneExperienceHost -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)
    if ($candidates.Count -eq 1) {
      $candidateRoot=$auto::FromHandle($candidates[0].MainWindowHandle)
      $ready=$candidateRoot.FindFirst($scope,(New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty,'PhoneNameTextBlock')))
      if ($ready) { $phoneProc=$candidates[0]; break }
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $phoneProc) { throw 'Mobile connecte ne presente pas une fenetre de telephone prete. Garde sa fenetre ouverte et relie ton telephone.' }
  $root = $auto::FromHandle($phoneProc.MainWindowHandle)
  function Find-In($parent, [string]$id) {
    return $parent.FindFirst($scope, (New-Object System.Windows.Automation.PropertyCondition($auto::AutomationIdProperty, $id)))
  }
  function Need([string]$id) {
    for ($i=0; $i -lt 20; $i++) {
      $e = Find-In $root $id
      if ($null -ne $e) { return $e }
      Start-Sleep -Milliseconds 100
    }
    $callError=Find-In $root 'DialerPaneErrorTitle'
    if ($callError) { throw ($callError.Current.Name + ' ' + (Text-Of $root 'DialerPaneErrorDescription')) }
    throw "Commande Mobile connecte introuvable : $id. Cette version de son interface n'est pas reconnue."
  }
  function Text-Of($parent, [string]$id) { $e=Find-In $parent $id; if ($e) { return $e.Current.Name }; return '' }
  function Value-Of($e) { return ([System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).Current.Value }
  function Set-Value($e, [string]$value) {
    ([System.Windows.Automation.ValuePattern]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($value)
    if ((Value-Of $e) -cne $value) { throw 'Le texte saisi ne correspond pas au texte demande. Action interrompue.' }
  }
  function Invoke-Control($e) {
    if (-not $e.Current.IsEnabled) { throw 'Le bouton de Mobile connecte est desactive. Verifie la connexion Bluetooth et les autorisations sur ton telephone.' }
    ([System.Windows.Automation.InvokePattern]$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
  }
  function Select-Tab([string]$id) {
    $e=Need $id
    ([System.Windows.Automation.SelectionItemPattern]$e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)).Select()
    Start-Sleep -Milliseconds 200
  }
  function Focus-Control($e) {
    [void][JarisPhone.Native]::ShowWindow($phoneProc.MainWindowHandle, 9)
    [void][JarisPhone.Native]::SetForegroundWindow($phoneProc.MainWindowHandle)
    $e.SetFocus()
    Start-Sleep -Milliseconds 80
    if ([JarisPhone.Native]::GetForegroundWindow() -ne $phoneProc.MainWindowHandle -or
        $auto::FocusedElement.Current.ProcessId -ne $phoneProc.Id -or
        $auto::FocusedElement.Current.AutomationId -ne $e.Current.AutomationId) {
      throw 'Mobile connecte ne possede pas le focus. Action interrompue pour ne pas ecrire dans une autre application.'
    }
  }
  function Key([byte]$code) {
    if ([JarisPhone.Native]::GetForegroundWindow() -ne $phoneProc.MainWindowHandle -or $auto::FocusedElement.Current.ProcessId -ne $phoneProc.Id) {
      throw 'Le focus a change. Action interrompue.'
    }
    [JarisPhone.Native]::keybd_event($code,0,0,[UIntPtr]::Zero)
    [JarisPhone.Native]::keybd_event($code,0,2,[UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
  }
  function Digits([string]$s) { return ($s -replace '[^0-9]', '') }
  function Check-Connected {
    $connection=Need 'ConnectivityCardOpenButton'
    if ($connection.Current.Name -notmatch '^(Connecté|Connected)$') {
      throw ('Mobile connecte indique : ' + $connection.Current.Name + '. Reconnecte le telephone avant cette action.')
    }
  }
  [void](Need 'PhoneNameTextBlock')
  if ($request.action -eq 'notifications') {
    $hostPanel=Find-In $root 'NotificationsListScrollHost'
    if (-not $hostPanel) {
      $disconnected=$root.FindFirst($scope,(New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty,'Déconnecté')))
      if (-not $disconnected) { $disconnected=$root.FindFirst($scope,(New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty,'Disconnected'))) }
      if ($disconnected) { throw 'Le panneau du telephone indique Deconnecte. Rapproche le telephone et reconnecte-le dans Mobile connecte.' }
      $hostPanel=Need 'NotificationsListScrollHost'
    }
    $items=$hostPanel.FindAll($scope,(New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[System.Windows.Automation.ControlType]::ListItem)))
    $notes=@()
    foreach($item in $items) {
      if ($notes.Count -ge 20) { break }
      $appName=Text-Of $item 'AppNameTextBlock'
      $title=Text-Of $item 'CompactModeTitleTextBlock'
      $body=Text-Of $item 'NotificationDescriptionText'
      if ($appName -or $title -or $body) { $notes += @{app=$appName; title=$title; body=$body} }
    }
    @{ok=$true; notifications=@($notes); status='read'} | ConvertTo-Json -Compress -Depth 5
    exit 0
  }
  if ($request.action -notin @('call','send')) { throw 'Action telephone inconnue.' }
  Check-Connected
  if ($request.number -notmatch '^\+?[0-9]{6,15}$') { throw 'Numero de telephone invalide.' }
  if ($request.action -eq 'send') {
    Select-Tab 'ChatNodeAutomationId'
    $old=Find-In $root 'InputTextBox'
    if ($old -and -not [string]::IsNullOrWhiteSpace((Value-Of $old))) { throw 'Un brouillon est deja ouvert dans Mobile connecte. Termine-le avant de demander un autre message.' }
    Invoke-Control (Need 'NewMessageButton')
    $recipient=Need 'TextBox'
    Set-Value $recipient $request.number
    Focus-Control $recipient
    Key 13
    Start-Sleep -Milliseconds 250
    $pane=Need 'ConversationPane'
    $headers=$pane.FindAll([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text)))
    $matched=$false
    foreach($header in $headers) { if ((Digits $header.Current.Name) -eq (Digits $request.number)) { $matched=$true } }
    if (-not $matched) { throw 'Le numero du destinataire ne peut pas etre verifie dans la conversation. Aucun message envoye.' }
    if ([string]::IsNullOrWhiteSpace($request.text) -or $request.text.Length -gt 4000) { throw 'Le message doit contenir entre 1 et 4000 caracteres.' }
    $composer=Need 'InputTextBox'
    Set-Value $composer $request.text
    $button=Need 'SendMessageButton'
    if (-not $button.Current.IsEnabled) { throw 'Envoi indisponible dans Mobile connecte. Le brouillon reste ouvert.' }
    if ($request.prepareOnly -eq $true) {
      Set-Value $composer ''
      @{ok=$true; status='prepared'; recipientVerified=$true; textVerified=$true} | ConvertTo-Json -Compress
      exit 0
    }
    # Aucune relance automatique : une exception APRES Invoke peut masquer un envoi deja effectue.
    Check-Connected
    $currentPane=Need 'ConversationPane'
    $currentHeaders=$currentPane.FindAll([System.Windows.Automation.TreeScope]::Children,(New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text)))
    $stillMatched=$false
    foreach($header in $currentHeaders) { if ((Digits $header.Current.Name) -eq (Digits $request.number)) { $stillMatched=$true } }
    if (-not $stillMatched) { throw 'Le destinataire a change. Aucun message envoye.' }
    $composer=Need 'InputTextBox'
    $button=Need 'SendMessageButton'
    if ((Value-Of $composer) -cne $request.text) { throw 'Le brouillon a change. Aucun envoi declenche.' }
    $attempted=$true
    [Console]::WriteLine('{"attempted":true}')
    Invoke-Control $button
    Start-Sleep -Milliseconds 700
    $cleared=[string]::IsNullOrEmpty((Value-Of (Need 'InputTextBox')))
    @{ok=$true; status='submitted'; composerCleared=$cleared} | ConvertTo-Json -Compress
    exit 0
  }
  Select-Tab 'CallingNodeAutomationId'
  $accumulator=Need 'AccumulatorTextBlock'
  if (-not [string]::IsNullOrEmpty($accumulator.Current.Name)) { throw 'Un numero est deja compose dans Mobile connecte. Efface-le avant de demander un autre appel.' }
  Focus-Control (Need 'Button1')
  # Les touches NUMPAD evitent les chiffres interpretes comme ponctuation avec un clavier AZERTY.
  $dial=$request.number -replace '^\+', '00'
  foreach($digit in $dial.ToCharArray()) { Key ([byte](96 + [int]::Parse([string]$digit))) }
  if ((Digits (Need 'AccumulatorTextBlock').Current.Name) -ne $dial) { throw 'Le numero compose ne correspond pas au destinataire. Aucun appel lance.' }
  $button=Need 'ButtonCall'
  if (-not $button.Current.IsEnabled) { throw 'Les appels sont indisponibles dans Mobile connecte. Verifie le Bluetooth.' }
  if ($request.prepareOnly -eq $true) {
    foreach($digit in $dial.ToCharArray()) { Key 8 }
    @{ok=$true; status='prepared'; recipientVerified=$true} | ConvertTo-Json -Compress
    exit 0
  }
  Check-Connected
  if ((Digits (Need 'AccumulatorTextBlock').Current.Name) -ne $dial) { throw 'Le numero a change. Aucun appel lance.' }
  $attempted=$true
  [Console]::WriteLine('{"attempted":true}')
  Invoke-Control $button
  @{ok=$true; status='submitted'} | ConvertTo-Json -Compress
} catch {
  @{ok=$false; error=$_.Exception.Message; attempted=$attempted} | ConvertTo-Json -Compress
  exit 1
}
`
