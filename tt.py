import os
import time
import glob
import shutil
import requests
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse, quote
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException, NoSuchElementException, WebDriverException
from selenium.webdriver.chrome.service import Service

# Try to import undetected_chromedriver for Cobalt
try:
    import undetected_chromedriver as uc
    UC_AVAILABLE = True
except ImportError:
    UC_AVAILABLE = False
    print("undetected-chromedriver not installed. Install with: pip install undetected-chromedriver")

# --- Setup folders ---
os.makedirs('downloads', exist_ok=True)

# Shared resources locks
print_lock = threading.Lock()
existing_files_lock = threading.Lock()

def safe_print(*args, **kwargs):
    with print_lock:
        print(*args, **kwargs)

# --- Helper: extract username + videoid ---
def extract_tiktok_info(url):
    try:
        parsed = urlparse(url)
        parts = parsed.path.strip('/').split('/')
        if len(parts) >= 3 and parts[0].startswith('@') and parts[1] == 'video':
            username = parts[0][1:].strip()
            videoid = parts[2].strip()
            return username, videoid
    except Exception:
        pass
    return "unknown_user", "unknown_id"

# --- Helper: sanitize filename ---
def sanitize_filename(username, videoid):
    safe_username = "".join(c for c in username if c.isalnum() or c in (' ', '_', '-')).strip()
    safe_username = " ".join(safe_username.split()) # remove double spaces
    videoid = videoid.strip() if videoid else "unknown_id"
    return f"{safe_username} - {videoid}.mp4"

# --- Helper: make unique filename if needed (checks downloads + mapped dirs) ---
def make_unique_filename(filename, existing_files_set):
    name, ext = os.path.splitext(filename)
    candidate = filename
    i = 1
    with existing_files_lock:
        while candidate in existing_files_set:
            candidate = f"{name} ({i}){ext}"
            i += 1
        existing_files_set.add(candidate)
    return candidate

# --- Download helper ---
def download_file_from_href(href, cookies, referer, tiktok_url, output_dir='downloads', max_retries=2, allow_duplicate=False, existing_files_set=None):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': referer,
    }
    session = requests.Session()
    for cookie in cookies:
        try:
            session.cookies.set(cookie['name'], cookie['value'])
        except Exception:
            pass
    username, videoid = extract_tiktok_info(tiktok_url)
    filename = sanitize_filename(username, videoid)

    # If duplicates allowed, find a unique filename across downloads + mapped dirs
    if allow_duplicate:
        unique_name = make_unique_filename(filename, existing_files_set)
        filepath = os.path.join(output_dir, unique_name)
    else:
        filepath = os.path.join(output_dir, filename)

    if not allow_duplicate and os.path.exists(filepath):
        safe_print(f" File already exists, skipping download: {os.path.basename(filepath)}")
        return True

    for attempt in range(1, max_retries + 1):
        try:
            safe_print(f" Downloading {os.path.basename(filepath)} (attempt {attempt})...")
            # Increase timeout and use larger chunk size for speed
            response = session.get(href, headers=headers, stream=True, timeout=60)
            response.raise_for_status()
            expected_size = int(response.headers.get("Content-Length", 0))

            with open(filepath, 'wb') as f:
                for chunk in response.iter_content(chunk_size=1024*1024): # 1MB chunks
                    if chunk:
                        f.write(chunk)

            actual_size = os.path.getsize(filepath)
            if expected_size and actual_size + 1024 < expected_size:
                safe_print(f"⚠️ Incomplete file ({actual_size} < {expected_size}) — retrying...")
                try:
                    os.remove(filepath)
                except Exception:
                    pass
                continue

            if expected_size:
                safe_print(f" ✅ Saved: {filepath} ({actual_size / 1024 / 1024:.1f} MB / expected {expected_size / 1024 / 1024:.1f} MB)")
            else:
                safe_print(f" ✅ Saved: {filepath} ({actual_size / 1024 / 1024:.1f} MB, size unknown)")
            return True
        except Exception as e:
            safe_print(f" Download error on attempt {attempt}: {e}")
            try:
                if os.path.exists(filepath):
                    os.remove(filepath)
            except Exception:
                pass
        time.sleep(1)
    safe_print(f" ❌ Failed to download complete file after {max_retries} attempts.")
    return False

# --- Helper: click "Do not consent" on MusicalDown whenever visible ---
def try_click_do_not_consent(driver):
    try:
        btns = driver.find_elements(By.CSS_SELECTOR, "button.fc-cta-do-not-consent, button.fc-button.fc-cta-do-not-consent")
        for btn in btns:
            try:
                if btn.is_displayed():
                    safe_print("Found 'Do not consent' button — clicking it.")
                    driver.execute_script("arguments[0].click();", btn)
                    time.sleep(1.0)
                    return True
            except Exception:
                pass
    except Exception:
        pass
    return False

def create_driver(selected, use_uc):
    options = webdriver.ChromeOptions()
    options.add_argument('--no-sandbox')
    options.add_argument('--disable-dev-shm-usage')
    options.add_argument('--disable-gpu')
    options.add_argument('--remote-debugging-port=0') # Let it pick a random port
    options.add_experimental_option("prefs", {
        "download.default_directory": os.path.abspath("downloads"),
        "download.prompt_for_download": False,
        "download.directory_upgrade": True,
        "safebrowsing.enabled": True
    })
    if selected["headless"]:
        options.add_argument("--headless=new")

    if selected["site_name"].lower() == "cobalt" and not selected["headless"]:
        options.add_argument('--disable-blink-features=AutomationControlled')

    driver = None
    if selected["site_name"].lower() == "cobalt" and use_uc:
        driver = uc.Chrome(options=options, version_main=None)
    else:
        service = Service('./chromedriver.exe')
        driver = webdriver.Chrome(service=service, options=options)
        if selected["site_name"].lower() == "cobalt":
            try:
                driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
            except Exception:
                pass
    driver.implicitly_wait(5)
    return driver

# Thread-local storage for driver
thread_local = threading.local()

def get_driver(selected, use_uc):
    if not hasattr(thread_local, "driver"):
        thread_local.driver = create_driver(selected, use_uc)
    return thread_local.driver

def process_url(url, selected, use_uc, existing_files_set, check_exists):
    url_success = False
    sd_info = None
    try:
        driver = get_driver(selected, use_uc)
        wait = WebDriverWait(driver, 20)
        username, videoid = extract_tiktok_info(url)
        filename = sanitize_filename(username, videoid)
        filepath = os.path.join('downloads', filename)

        if check_exists and os.path.exists(filepath):
            safe_print(f" File exists, skipping: {filename}")
            return True, None, None

        retries, max_retries = 0, 3
        while retries < max_retries and not url_success:
            retries += 1
            try:
                driver.get(selected["site_url"])
                try_click_do_not_consent(driver)

                href = None
                cookies = []
                referer = driver.current_url

                if selected["site_name"].lower() == "cobalt":
                    url_input = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "input[type='url'], input[placeholder*='URL'], input[placeholder*='link'], textarea")))
                    url_input.clear()
                    url_input.send_keys(url)
                    try:
                        submit_btn = wait.until(EC.element_to_be_clickable((By.ID, "download-button")))
                    except TimeoutException:
                        submit_btn = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "button, input[type=submit]")))
                    submit_btn.click()

                    # Cobalt processing wait
                    time.sleep(5)
                    try:
                        download_anchor = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "a[href$='.mp4'], .download a, a.download")))
                        href = download_anchor.get_attribute('href') or download_anchor.get_attribute('data-url')
                        cookies = driver.get_cookies()
                        referer = driver.current_url
                    except TimeoutException:
                        raise

                elif selected["site_name"].lower() == "musicaldown":
                    url_input = wait.until(EC.presence_of_element_located((By.ID, "link_url")))
                    url_input.clear()
                    url_input.send_keys(url)
                    submit_btn = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "form#submit-form button[type=submit], form button[type=submit]")))
                    submit_btn.click()

                    try:
                        download_anchor = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "a.download[data-event='hd_download_click']")), timeout=12)
                        href = download_anchor.get_attribute('href') or download_anchor.get_attribute('data-url')
                        cookies = driver.get_cookies()
                        referer = driver.current_url
                    except TimeoutException:
                        try:
                            fallback_anchor = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "a.download")), timeout=12)
                            href = fallback_anchor.get_attribute('href') or fallback_anchor.get_attribute('data-url')
                            cookies = driver.get_cookies()
                            referer = driver.current_url
                            sd_info = {"tiktok_url": url, "href": href}
                        except TimeoutException:
                            raise
                else: # TikWM
                    url_input = wait.until(EC.presence_of_element_located((By.ID, "params")))
                    url_input.clear()
                    url_input.send_keys(url)
                    submit_btn = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "button.btn-submit")))
                    submit_btn.click()
                    time.sleep(2)
                    try:
                        error_box = driver.find_element(By.CSS_SELECTOR, "div.alert.alert-danger[role='alert']")
                        if "url parsing is failed" in error_box.text.lower():
                            return False, url, None
                    except NoSuchElementException:
                        pass
                    download_link = wait.until(EC.presence_of_element_located((By.CSS_SELECTOR, "a.btn.btn-success[download]")))
                    href = download_link.get_attribute('href')
                    cookies = driver.get_cookies()
                    referer = driver.current_url

                if href and download_file_from_href(href, cookies, referer, url, allow_duplicate=not check_exists, existing_files_set=existing_files_set):
                    url_success = True
                    break
            except Exception as e:
                safe_print(f" Error processing {url} on attempt {retries}: {e}")
                time.sleep(1)

        return url_success, (None if url_success else url), sd_info

    except Exception as e:
        safe_print(f" Fatal error for {url}: {e}")
        return False, url, None

def close_drivers(executor):
    # This is a bit tricky with ThreadPoolExecutor and thread_local
    # We'll use a small hack to run a task on each thread to close its driver
    def _close():
        if hasattr(thread_local, "driver"):
            try:
                thread_local.driver.quit()
            except Exception:
                pass
            del thread_local.driver

    # Run _close on all possible threads
    futures = [executor.submit(_close) for _ in range(executor._max_workers * 2)]
    for f in as_completed(futures): pass

def main():
    # --- Read URLs ---
    if not os.path.exists('urls.txt'):
        print("urls.txt not found.")
        return
    with open('urls.txt', 'r', encoding='utf-8') as f:
        urls = [line.strip() for line in f if line.strip()]

    # --- FILTER ---
    filtered_out_urls = [u for u in urls if 'photo' in u.lower()]
    urls = [u for u in urls if 'photo' not in u.lower()]
    if filtered_out_urls:
        print(f"Ignoring {len(filtered_out_urls)} URL(s) containing 'photo'.")

    if not urls:
        print("No URLs in urls.txt after filtering.")
        return

    # --- Load user directory map ---
    user_map = {}
    if os.path.exists('user_dir_map.txt'):
        with open('user_dir_map.txt', 'r', encoding='utf-8') as f:
            for line in f:
                if ':' in line:
                    u, d = line.strip().split(':', 1)
                    user_map[u.strip()] = d.strip()

    # --- Gather existing filenames ---
    # PRE-SCAN ONLY ONCE
    existing_files = set(os.listdir('downloads'))
    base_td = r"C:\Bridge\Downloads\td"
    print(f"Pre-scanning {base_td} for existing files...")
    for username, subdir in user_map.items():
        target_dir = os.path.join(base_td, subdir)
        if os.path.exists(target_dir):
            for f in os.listdir(target_dir):
                existing_files.add(f)
    print("Pre-scan complete.")

    # --- Menu ---
    sites = [
        ("TikWM", "https://www.tikwm.com/originalDownloader.html"),
        ("MusicalDown", "https://musicaldown.com/en"),
        ("Cobalt", "https://cobalt.tools")
    ]
    actions = [
        ("Start in headless mode", {"kill_before": False, "headless": True}),
        ("Start in visible mode", {"kill_before": False, "headless": False}),
        ("Kill all Chrome/Chromedriver, then start headless", {"kill_before": True, "headless": True}),
        ("Kill all Chrome/Chromedriver, then start visible", {"kill_before": True, "headless": False})
    ]
    print("Select one option (1-12):")
    menu_options = []
    idx = 1
    for s_name, s_url in sites:
        for action_name, params in actions:
            print(f"{idx}) {action_name} using {s_name}")
            menu_options.append({
                "index": idx,
                "site_name": s_name,
                "site_url": s_url,
                "kill_before": params["kill_before"],
                "headless": params["headless"]
            })
            idx += 1

    choice = input("Choose option number (default 1): ").strip()
    selected = menu_options[int(choice)-1] if choice.isdigit() and 1 <= int(choice) <= len(menu_options) else menu_options[0]

    use_uc = False
    if selected["site_name"].lower() == "cobalt":
        if UC_AVAILABLE:
            use_uc = input("Use undetected-chromedriver? (y/n, default y): ").strip().lower() != 'n'

    concurrency = input("Number of concurrent downloads (default 3): ").strip()
    concurrency = int(concurrency) if concurrency.isdigit() else 3

    check_exists = input("Check for existing files before downloading? (y/n, default y): ").strip().lower() != 'n'

    if selected["kill_before"]:
        try:
            subprocess.call(['taskkill', '/f', '/im', 'chrome.exe'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.call(['taskkill', '/f', '/im', 'chromedriver.exe'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
        time.sleep(1.0)

    # --- Processing ---
    successful = 0
    failed_urls = []
    sd_saved = []

    print(f"\nProcessing {len(urls)} URLs with concurrency {concurrency}...\n")

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(process_url, url, selected, use_uc, existing_files, check_exists): url for url in urls}
        for future in as_completed(futures):
            res_success, res_failed_url, res_sd_info = future.result()
            if res_success:
                successful += 1
            if res_failed_url:
                failed_urls.append(res_failed_url)
            if res_sd_info:
                sd_saved.append(res_sd_info)

        print("\nCleaning up drivers...")
        close_drivers(executor)

    # --- Summary & Move ---
    print(f"\nAutomation complete! Successful: {successful}/{len(urls)}")
    if failed_urls:
        print(f"Failed: {len(failed_urls)}")
        if input("Generate failed_urls.txt? (y/n): ").strip().lower() == 'y':
            with open('failed_urls.txt', 'w', encoding='utf-8') as f:
                for u in failed_urls: f.write(u + '\n')

    if sd_saved:
        print(f"\nSD Fallback count: {len(sd_saved)}")
        if input("Write SD fallback report? (y/n, default y): ").strip().lower() != 'n':
            with open('sd_fallback.txt', 'w', encoding='utf-8') as f:
                for s in sd_saved: f.write(f"{s['tiktok_url']} -> {s['href']}\n")

    # Move logic
    move_files_to_user_dirs(base_td)

def load_user_map(map_file='user_dir_map.txt'):
    user_map = {}
    if os.path.exists(map_file):
        with open(map_file, 'r', encoding='utf-8') as f:
            for line in f:
                if ':' in line:
                    u, d = line.strip().split(':', 1)
                    user_map[u.strip()] = d.strip()
    return user_map

def save_user_map(user_map, map_file='user_dir_map.txt'):
    with open(map_file, 'w', encoding='utf-8') as f:
        for u, d in user_map.items():
            f.write(f"{u}:{d}\n")

def move_files_to_user_dirs(base_dir=r"C:\Bridge\Downloads\td"):
    user_map = load_user_map()
    if not os.path.exists('downloads'): return
    downloads = [f for f in os.listdir('downloads') if f.lower().endswith('.mp4')]
    if not downloads:
        print("No files to move.")
        return
    print(f"\nMove downloaded files to user directories under {base_dir}?")
    resp = input("(y/n): ").strip().lower()
    if resp != 'y':
        return
    usernames = {}
    for f in downloads:
        if ' - ' in f:
            u = f.split(' - ')[0].strip()
            usernames.setdefault(u, []).append(f)
        else:
            usernames.setdefault('unknown_user', []).append(f)
    moved, replaced, skipped = 0, 0, 0
    # Auto-move for mapped users
    for username, files in list(usernames.items()):
        if username in user_map:
            subdir = user_map[username]
            dest_dir = os.path.join(base_dir, subdir)
            os.makedirs(dest_dir, exist_ok=True)
            print(f"\nAuto-moving {len(files)} file(s) for '{username}' to '{dest_dir}'...")
            for fname in files:
                src = os.path.join('downloads', fname)
                dst = os.path.join(dest_dir, fname)
                if os.path.exists(dst):
                    src_size = os.path.getsize(src)
                    dst_size = os.path.getsize(dst)
                    if src_size == dst_size:
                        shutil.move(src, dst)
                        replaced += 1
                        print(f" Replaced existing (same size): {fname}")
                    else:
                        skipped += 1
                        print(f" Skipped (size mismatch): {fname}")
                else:
                    shutil.move(src, dst)
                    moved += 1
                    print(f" Moved: {fname}")
            del usernames[username]
    # Ask for unmapped users
    for username, files in usernames.items():
        print(f"\n=== User: {username} ===")
        subdir = input(f"Enter directory under td for '{username}': ").strip()
        if not subdir:
            print(" Skipped (no directory provided).")
            continue
        user_map[username] = subdir
        dest_dir = os.path.join(base_dir, subdir)
        os.makedirs(dest_dir, exist_ok=True)
        for fname in files:
            src = os.path.join('downloads', fname)
            dst = os.path.join(dest_dir, fname)
            shutil.move(src, dst)
            moved += 1
            print(f" Moved: {fname}")
    save_user_map(user_map)
    print(f"\nMove summary: {moved} moved, {replaced} replaced, {skipped} skipped.")
    print("User directory mappings saved to user_dir_map.txt\n")

if __name__ == "__main__":
    main()
