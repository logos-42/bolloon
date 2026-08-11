import re, sys, zipfile

apk = sys.argv[1]
with zipfile.ZipFile(apk) as z:
    for name in sorted(n for n in z.namelist() if re.match(r'classes\d*\.dex$', n)):
        dex = z.read(name)
        for pat in [b'com/bolloon/agent/rokid', b'RokidBridgePlugin', b'com/rokid/cxr/CXRServiceBridge', b'com/getcapacitor/BridgeActivity']:
            n = dex.count(pat)
            if n:
                print(f'{name}: {pat.decode()} x{n}')
