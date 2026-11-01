import asyncio
import re
from urllib.parse import urlparse

from main import masked_candidate, ad_host, url_allowed, mock_url


def test_query_fingerprints_differ():
    a = masked_candidate('https://cdn.example.com/live.m3u8?token=abc')
    b = masked_candidate('https://cdn.example.com/live.m3u8?token=def')
    assert a['tokenPresent'] and b['tokenPresent']
    assert a['tokenFingerprint'] != b['tokenFingerprint']
    assert a['urlFingerprint'] != b['urlFingerprint']
    assert len(a['tokenFingerprint']) == 16
    assert 'abc' not in str(a)


def test_same_token_hash_stable():
    u = 'https://cdn.example.org/live/master.m3u8?signature=aaa&expires=123'
    assert masked_candidate(u)['tokenFingerprint'] == masked_candidate(u)['tokenFingerprint']


def test_host_blocklist_exact_suffix():
    assert ad_host('x.doubleclick.net')
    assert ad_host('doubleclick.net')
    assert not ad_host('notdoubleclick.net')
    assert not ad_host('example.com')


def test_public_and_private_urls():
    async def run():
        assert not await url_allowed('http://localhost:8000/admin')
        assert not await url_allowed('http://127.0.0.1:1234/')
        assert not await url_allowed('http://169.254.169.254/latest/meta-data')
        assert not await url_allowed('file:///etc/passwd')
        assert not await url_allowed('https://user:pass@example.org/')
        assert await url_allowed('http://127.0.0.1:8000/mock/watch')
        assert not await url_allowed('http://127.0.0.1:8000/docs')
    asyncio.run(run())


def test_mock_url_exact_path():
    assert mock_url('http://127.0.0.1:8000/mock/watch')
    assert not mock_url('http://127.0.0.1:8000/secret')
    assert not mock_url('http://127.0.0.1:9000/mock/watch')
