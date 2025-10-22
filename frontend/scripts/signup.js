import { auth, db } from "./firebaseInit.js";
import {
  createUserWithEmailAndPassword,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";

const signupForm = document.getElementById("the-signup-form");
const signupBtn = document.getElementById("signup-btn");
const errorDiv = document.getElementById("error-box");
const successDiv = document.getElementById("success-popup");

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  signupBtn.disabled = true;
  signupBtn.textContent = "Working on it...";

  errorDiv.style.display = "none";

  const username = document.getElementById("username").value;
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  const confirmPass = document.getElementById("confirm-password").value;

  if (password !== confirmPass) {
    displayErrorMsg("Passwords do not match.");
    return;
  }

  try {
    const newUser = await createUserWithEmailAndPassword(auth, email, password);
    const user = newUser.user;

    await updateProfile(user, {
      displayName: username,
    });

    const userDoc = doc(db, "users", user.uid);
    await setDoc(userDoc, {
      username: username,
      email: email,
      createdAt: serverTimestamp(),
    });

    displaySuccessMsg("Registration successful! Redirecting...");

    try {
      const backendUrl = "https://ally-back.onrender.com/send-welcome-email";
      await fetch(backendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: user.email, username: username }),
      });
    } catch (emailError) {
      console.error("couldnt send the welcome email", emailError);
    }

    setTimeout(() => {
      window.location.href = "home.html";
    }, 2000);
  } catch (error) {
    console.error("Sign up failed:", error);
    let friendlyMessage = "Something went wrong. Please try again.";

    if (error.code == "auth/email-already-in-use") {
      friendlyMessage =
        "This email address is already in use. Please try another one or sign in.";
    } else if (error.code == "auth/invalid-email") {
      friendlyMessage = "Please enter a valid email address.";
    } else if (error.code == "auth/weak-password") {
      friendlyMessage =
        "The password is too weak. Please use at least 6 characters.";
    }
    displayErrorMsg(friendlyMessage);
  }
});

function displayErrorMsg(message) {
  errorDiv.textContent = message;
  errorDiv.style.display = "block";

  signupBtn.disabled = false;
  signupBtn.textContent = "Sign Up";
}

function displaySuccessMsg(message) {
  successDiv.textContent = message;
  successDiv.classList.remove("hidden");
}
