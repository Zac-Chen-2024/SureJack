#!/usr/bin/env python3
"""临时在 443 上起明文监听，验证 TCP 入站可达性。

测的是「路通不通」，和 TLS 无关——先确认包能进来，再谈证书。
15 分钟后自动退出，避免忘记关闭。
"""
import http.server
import socketserver
import threading

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ua = self.headers.get('User-Agent', '')[:60]
        print(f"  ✓ 外部连接：{self.client_address[0]}  {ua}", flush=True)
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.end_headers()
        self.wfile.write('SUREJACK_443_OK\n443 入站可达，可以关掉这个页面了。\n'.encode())

    def log_message(self, *args):
        pass

socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('0.0.0.0', 443), Handler)

def stop():
    print('  ⏰ 15 分钟到，自动关闭', flush=True)
    srv.shutdown()

threading.Timer(900, stop).start()
print('  监听 0.0.0.0:443（15 分钟后自动关闭）…', flush=True)
srv.serve_forever()
