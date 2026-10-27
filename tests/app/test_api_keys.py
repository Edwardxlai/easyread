import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from easyread.app import config
from easyread.app.api_keys import resolve
from easyread.chat.chat_models import engine_cfg
from easyread.server import settings_api


class EndpointKeysTest(unittest.TestCase):
    def test_image_service_keys_are_masked_preserved_and_isolated_by_endpoint(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_PATH", Path(tmp) / "config.json"):
            settings_api.save_config({"figure_images": {"enabled": True, "base_url": "https://a.example/v1", "api_key": "image-secret", "model": "editor"}})
            shown = config.public(config.load())
            self.assertEqual(shown["figure_images"]["api_key"], "••••cret")
            self.assertNotIn("image-secret", str(shown))
            settings_api.save_config({"figure_images": {"api_key": "••••cret", "model": "another-editor"}})
            self.assertEqual(config.load()["figure_images"]["api_key"], "image-secret")
            settings_api.save_config({"figure_images": {"base_url": "https://b.example/v1", "api_key": "••••cret"}})
            self.assertEqual(config.load()["figure_images"]["api_key"], "")
            self.assertEqual(config.load()["openai"]["api_key"], "")
            settings_api.save_config({"figure_images": {"base_url": "https://a.example/v1", "api_key": ""}})
            self.assertEqual(config.load()["figure_images"]["api_key"], "image-secret")

    def test_invalid_image_options_do_not_save(self):
        for value in (False, {"enabled": "yes"}, {"model": []}, {"timeout": 0},
                      {"base_url": "file:///tmp"}, {"base_url": "https://secret@example.com"}):
            with self.subTest(value=value), patch.object(config, "save") as save:
                with self.assertRaises(ValueError):
                    settings_api.save_config({"figure_images": value})
                save.assert_not_called()

    def test_switch_custom_endpoints_and_reload(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(config, "CONFIG_PATH", Path(tmp) / "config.json"):
            for url, key in [("https://a.example/v1/", "key-a"), ("https://b.example/v1", "key-b")]:
                config.save({"engine": "openai", "openai": config.with_key({"preset": "", "base_url": url, "api_key": key})})
            for url, expected in [("https://a.example/v1", "key-a"), ("https://b.example/v1/", "key-b")]:
                cfg = config.save({"openai": config.with_key({"preset": "", "base_url": url, "api_key": ""})})
                self.assertEqual(cfg["openai"]["api_key"], expected)
                cfg["chat"] = {"models": [{"id": "m1", "engine": "openai", "preset": "", "base_url": url, "model": "test"}]}
                self.assertEqual(engine_cfg(cfg, "m1")[0]["openai"]["api_key"], expected)
                self.assertNotIn(expected, str(config.public(cfg)))
            self.assertEqual(resolve(cfg["openai"], "", "https://unknown.example/v1"), "")

    def test_legacy_key_only_migrates_to_current_endpoint(self):
        o = {"preset": "", "base_url": "https://old.example/v1", "keys": {"": "legacy"}}
        self.assertEqual(resolve(o, "", o["base_url"]), "legacy")
        self.assertEqual(resolve(o, "", "https://other.example/v1"), "")
