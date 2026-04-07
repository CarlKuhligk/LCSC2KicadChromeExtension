# Global imports
import logging
import time
from typing import Callable

import requests
from requests import codes as http_codes

from easyeda2kicad import __version__

# easyeda.com sits behind CloudFront; a library-style User-Agent often gets HTTP 403 HTML
# instead of JSON. Use a mainstream browser UA for the product API (verified LCSC e.g. C84681).
_EASYEDA_PRODUCT_API_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

API_ENDPOINT = "https://easyeda.com/api/products/{lcsc_id}/components?version=6.4.19.5"
ENDPOINT_3D_MODEL = "https://modules.easyeda.com/3dmodel/{uuid}"
ENDPOINT_3D_MODEL_STEP = "https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}"
# ENDPOINT_3D_MODEL_STEP found in https://modules.lceda.cn/smt-gl-engine/0.8.22.6032922c/smt-gl-engine.js : points to the bucket containing the step files.

# ------------------------------------------------------------


class EasyedaApi:
    def __init__(self, on_retry: Callable[[int, int], None] | None = None) -> None:
        self.headers = {
            "Accept-Encoding": "gzip, deflate",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": _EASYEDA_PRODUCT_API_USER_AGENT,
            "X-Client-Name": f"KiCad-Parts-Importer/easyeda2kicad-{__version__}",
        }
        self.on_retry = on_retry  # (attempt, max_attempts) called before sleeping on retry

    def get_info_from_easyeda_api(self, lcsc_id: str) -> dict:
        """GET LCSC component JSON from EasyEDA. Retries on empty body, bad JSON, and 5xx/429."""
        lcsc_id = lcsc_id.strip().upper()
        url = API_ENDPOINT.format(lcsc_id=lcsc_id)
        last_problem: str | None = None
        max_attempts = 3

        for attempt in range(1, max_attempts + 1):
            try:
                r = requests.get(url=url, headers=self.headers, timeout=15)
            except requests.RequestException as exc:
                last_problem = str(exc)
                logging.warning(
                    "EasyEDA API request failed for %s (%s/%s): %s",
                    lcsc_id,
                    attempt,
                    max_attempts,
                    exc,
                )
                if attempt < max_attempts:
                    if self.on_retry:
                        try:
                            self.on_retry(attempt, max_attempts)
                        except Exception:
                            pass
                    time.sleep(1.0)
                    continue
                raise

            snippet = (r.text or "").strip()
            if r.status_code != http_codes.ok:
                last_problem = f"HTTP {r.status_code}: {snippet[:300]!r}"
                logging.warning(
                    "EasyEDA API bad status for %s (%s/%s): %s",
                    lcsc_id,
                    attempt,
                    max_attempts,
                    last_problem,
                )
                if attempt < max_attempts and r.status_code in (
                    429,
                    500,
                    502,
                    503,
                    504,
                ):
                    if self.on_retry:
                        try:
                            self.on_retry(attempt, max_attempts)
                        except Exception:
                            pass
                    time.sleep(1.0)
                    continue
                break

            if not snippet:
                last_problem = f"HTTP {r.status_code} with empty body"
                logging.warning(
                    "EasyEDA API empty body for %s (%s/%s)",
                    lcsc_id,
                    attempt,
                    max_attempts,
                )
                if attempt < max_attempts:
                    time.sleep(1.0)
                    continue
                break

            try:
                api_response = r.json()
            except ValueError as exc:
                last_problem = (
                    f"response is not JSON ({exc!s}); starts with {snippet[:200]!r}"
                )
                logging.warning(
                    "EasyEDA API JSON decode for %s (%s/%s): %s",
                    lcsc_id,
                    attempt,
                    max_attempts,
                    last_problem,
                )
                if attempt < max_attempts:
                    time.sleep(1.0)
                    continue
                break

            if not api_response:
                logging.debug("%s", api_response)
                return {}
            if isinstance(api_response, dict) and api_response.get("success") is False:
                logging.debug("%s", api_response)
                return {}

            return api_response

        raise RuntimeError(
            f"EasyEDA API did not return usable JSON for {lcsc_id}. {last_problem or 'unknown'}"
        )

    def get_cad_data_of_component(self, lcsc_id: str) -> dict:
        cp_cad_info = self.get_info_from_easyeda_api(lcsc_id=lcsc_id)
        if cp_cad_info == {}:
            return {}
        return cp_cad_info["result"]

    def _get_with_retry(self, url: str, max_attempts: int = 3, timeout: int = 15) -> requests.Response:
        """GET with up to max_attempts retries, 1 second between attempts."""
        last_exc = None
        for attempt in range(1, max_attempts + 1):
            try:
                return requests.get(
                    url=url,
                    headers={"User-Agent": self.headers["User-Agent"]},
                    timeout=timeout,
                )
            except Exception as exc:
                last_exc = exc
                if attempt < max_attempts:
                    logging.debug("3D model request failed (%s/%s), retrying in 1s: %s", attempt, max_attempts, exc)
                    if self.on_retry:
                        try:
                            self.on_retry(attempt, max_attempts)
                        except Exception:  # do not let callback break retry
                            pass
                    time.sleep(1)
        raise last_exc

    def get_raw_3d_model_obj(self, uuid: str) -> str | None:
        try:
            r = self._get_with_retry(ENDPOINT_3D_MODEL.format(uuid=uuid), timeout=15)
        except Exception as exc:
            logging.warning(
                "Skipping raw 3D model for uuid %s (network/DNS or EasyEDA unreachable): %s",
                uuid,
                exc,
            )
            return None
        if r.status_code != requests.codes.ok:
            logging.warning(
                "No raw 3D model for uuid %s (HTTP %s); continuing without this asset",
                uuid,
                r.status_code,
            )
            return None
        return r.content.decode()

    def get_step_3d_model(self, uuid: str) -> bytes | None:
        try:
            r = self._get_with_retry(ENDPOINT_3D_MODEL_STEP.format(uuid=uuid), timeout=20)
        except Exception as exc:
            logging.warning(
                "Skipping STEP 3D model for uuid %s (network/DNS or EasyEDA unreachable): %s",
                uuid,
                exc,
            )
            return None
        if r.status_code != requests.codes.ok:
            logging.warning(
                "No STEP 3D model for uuid %s (HTTP %s); continuing without this asset",
                uuid,
                r.status_code,
            )
            return None
        return r.content
