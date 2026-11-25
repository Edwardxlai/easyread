import selectors
import socket
import time
import unittest
from http.server import BaseHTTPRequestHandler

from easyread.server import launch


class ListenBacklogTest(unittest.TestCase):
    def test_burst_of_connections_is_queued_without_retry(self):
        """页面一次请求几十个文件：服务还没来得及接，连接也要先排进队列，不能被丢掉等重连。"""
        httpd = launch._Server(("127.0.0.1", 0), BaseHTTPRequestHandler)  # 不调用 serve_forever：只看排队
        socks = []
        try:
            sel = selectors.DefaultSelector()
            for _ in range(32):
                s = socket.socket()
                s.setblocking(False)
                s.connect_ex(httpd.server_address)
                sel.register(s, selectors.EVENT_WRITE)
                socks.append(s)
            connected, deadline = set(), time.monotonic() + 0.5  # 被丢掉的连接要一秒后才重试
            while len(connected) < len(socks) and time.monotonic() < deadline:
                for key, _ in sel.select(timeout=0.1):
                    if key.fileobj.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR) == 0:
                        connected.add(key.fileobj)
                    sel.unregister(key.fileobj)
            self.assertEqual(len(connected), len(socks))
        finally:
            for s in socks:
                s.close()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
