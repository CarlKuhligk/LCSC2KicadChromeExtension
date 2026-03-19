# Global imports
import logging
import time
from typing import Callable

import requests

from easyeda2kicad import __version__

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
            "User-Agent": f"easyeda2kicad v{__version__}",
        }
        self.on_retry = on_retry  # (attempt, max_attempts) called before sleeping on retry

    def get_info_from_easyeda_api(self, lcsc_id: str) -> dict:
        r = requests.get(
            url=API_ENDPOINT.format(lcsc_id=lcsc_id),
            headers=self.headers,
            timeout=10,
        )
        api_response = r.json()

        if not api_response or (
            "code" in api_response and api_response["success"] is False
        ):
            logging.debug(f"{api_response}")
            return {}

        return r.json()

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
            logging.error("Failed to fetch raw 3D model for uuid:%s: %s", uuid, exc)
            return None
        if r.status_code != requests.codes.ok:
            logging.error("No raw 3D model data found for uuid:%s on easyeda (status %s)", uuid, r.status_code)
            return None
        return r.content.decode()

    def get_step_3d_model(self, uuid: str) -> bytes | None:
        try:
            r = self._get_with_retry(ENDPOINT_3D_MODEL_STEP.format(uuid=uuid), timeout=20)
        except Exception as exc:
            logging.error("Failed to fetch step 3D model for uuid:%s: %s", uuid, exc)
            return None
        if r.status_code != requests.codes.ok:
            logging.error("No step 3D model data found for uuid:%s on easyeda (status %s)", uuid, r.status_code)
            return None
        return r.content
