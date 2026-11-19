# Tab Layout Memory - removes the helper registration for the current user.
$HostName = 'com.tablayoutmemory.host'
foreach ($k in 'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
               'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
               'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
               'HKCU:\Software\Chromium\NativeMessagingHosts') {
    Remove-Item -Path "$k\$HostName" -Force -ErrorAction SilentlyContinue
}
Write-Host 'Helper unregistered. Remove the extension from your browser and delete this folder to finish.'
